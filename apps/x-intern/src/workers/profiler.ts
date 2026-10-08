import { loadEnv } from "../env.js";
import { createLogger } from "../lib/logger.js";
import { noelleDb } from "../lib/db.js";
import { listProfilerXInternInstances, isWorkerEnabled } from "../lib/activation.js";
import { recordRun } from "../lib/worker-runs.js";
import { busForInstance } from "../lib/bus.js";
import { runBootChecks, EX_TEMPFAIL } from "../lib/boot.js";
import { createSecretsClient, SecretAccessError, APIFY_TOKEN_SECRET_ID } from "../lib/secrets.js";
import { createApifyResolver } from "../lib/apify-resolver.js";
import { AllApifyTokensExhaustedError } from "../lib/apify-rotating.js";
import { createRateBucket } from "../lib/rate-bucket.js";
import { createCodexRunner } from "../lib/codex-runner.js";
import { createPgSpendRecorder } from "@noelle/runtime/pg-spend-recorder";
import { createPgBudgetAdapters, CAP_EXEMPT_ENGINES_APIFY_XAPI } from "@noelle/runtime/pg-budget-adapters";
import { createBedrockBackend, createClaudeCliBackend } from "@noelle/runtime";
import type { EngineBackend, CreateClaudeCliBackendOptions } from "@noelle/runtime";
import {
  listWatchlistPeopleNeedingProfile,
  listRepliedPeopleNeedingProfile,
  upsertWatchlistProfile,
  markProfileAttempted,
} from "../lib/profiles-db.js";
import { mergeProfilerQueue } from "../lib/profiler-queue.js";
import { runWorkerLoop, installShutdown } from "./_runtime.js";
import { runAnalystTick } from "./analyst-tick.js";
import { runProfilerTick } from "./profiler-tick.js";

/** Per-instance stamp for the analyst interval (in-memory; a restart just costs
 * one extra run, and the run itself is bounded by playbook staleness). */
const lastAnalystAt = new Map<string, number>();

async function main() {
  const env = loadEnv();
  const log = createLogger({ kind: "profiler", workerId: env.WORKER_ID });
  const sql = noelleDb();
  const secrets = createSecretsClient({ project: env.GCP_PROJECT });
  const recorder = createPgSpendRecorder(sql);
  const bucket = createRateBucket({ tokens: env.X_RATE_TOKENS, windowMs: env.X_RATE_WINDOW_MS });
  // Apify reads (see X_SCRAPER_ACTOR_ID in @noelle/x-apify) over the shared rotating 'apify'
  // token pool — no X cookies, so the profiler's bulk history fetch can't lock
  // the account. (Reads only; bird cookies still post replies in the send worker.)
  const resolveApify = createApifyResolver({
    sql,
    secrets,
    apifyTokenSecretId: APIFY_TOKEN_SECRET_ID,
    log,
  });

  const boot = await runBootChecks({
    log,
    checks: [
      { name: "db.ping", kind: "transient", run: async () => { await sql`select 1 as ok`; } },
    ],
  });
  if (!boot.ok) process.exit(boot.exitCode);

  // Bedrock — same engine + provisioning as the drafter. The profiler makes one
  // LLM call per (re)profiled person. Missing keys → fail loudly on first tick.
  const engines: Record<string, EngineBackend> = {};
  try {
    const [bedrockAccess, bedrockSecret] = await Promise.all([
      secrets.get("noelle-worker-bedrock-aws-access-key-id"),
      secrets.get("noelle-worker-bedrock-aws-secret-access-key"),
    ]);
    engines.bedrock = createBedrockBackend({
      accessKeyId: bedrockAccess,
      secretAccessKey: bedrockSecret,
    });
    log.info({}, "bedrock backend ready");
  } catch (err) {
    if (err instanceof SecretAccessError && /NOT_FOUND/.test(err.message)) {
      log.warn({}, "no bedrock AWS keys in Secret Manager; profiler will fail every tick until provisioned");
    } else {
      throw err;
    }
  }

  // claude -p primary, Bedrock fallback. When the local Claude subscription is
  // wired (NOELLE_CLAUDE_CLI=1), register it so callAgentModel rewrites the
  // bedrock PRIMARY handle to claude-cli (flat-rate, ~$0) and keeps Bedrock as
  // the routing fallback if the CLI errors (auth/rate-limit/timeout).
  if (process.env.NOELLE_CLAUDE_CLI === "1") {
    const cliOpts: CreateClaudeCliBackendOptions = {};
    if (process.env.NOELLE_CLAUDE_CLI_PATH) cliOpts.cliPath = process.env.NOELLE_CLAUDE_CLI_PATH;
    if (process.env.NOELLE_CLAUDE_CLI_TIMEOUT_MS) {
      cliOpts.timeoutMs = Number(process.env.NOELLE_CLAUDE_CLI_TIMEOUT_MS);
    }
    engines["claude-cli"] = createClaudeCliBackend(cliOpts);
    log.info({}, "claude-cli backend ready (bedrock fallback)");
  }

  const runner = createCodexRunner({
    engines,
    sql,
    budget: { adapters: createPgBudgetAdapters(sql, { exemptEngines: CAP_EXEMPT_ENGINES_APIFY_XAPI }) },
    recorder,
  });

  log.info({}, "profiler worker ready");
  const shouldStop = installShutdown(log);

  await runWorkerLoop({
    log,
    kind: "profiler",
    pollMs: env.PROFILER_POLL_MS,
    idlePollMs: env.IDLE_POLL_MS,
    listActive: () => listProfilerXInternInstances(sql),
    onTick: async (inst) => {
      // Per-instance gate (0024). The profiler is decoupled from Start/Pause —
      // its selector returns paused instances too — so this flag is the only
      // switch: an operator can run profiling alone while the pipeline is off.
      if (!isWorkerEnabled(inst, "profiler")) {
        log.debug({ instance: inst.id }, "profiler disabled for instance; skipping");
        return;
      }
      const bus = busForInstance(inst);
      const run = await recordRun({ sql, kind: "profiler", bus });
      try {
        // ENGAGEMENT ANALYST, hosted here because it is the other half of the
        // same job: the profiler learns WHO a watched person is, the analyst
        // learns HOW they win. It costs no Apify at all (the engagement counts
        // are already on the leads) and is throttled by playbook staleness, so
        // most ticks do nothing. Fail-soft: an analyst error must never stop the
        // profiling below. Default OFF.
        if (env.X_ENGAGEMENT_ANALYST) {
          const now = Date.now();
          const last = lastAnalystAt.get(inst.id) ?? 0;
          if (now - last >= env.X_PLAYBOOK_INTERVAL_MS) {
            lastAnalystAt.set(inst.id, now);
            await runAnalystTick({
              sql,
              log,
              instance: inst,
              runner,
              windowDays: env.X_PLAYBOOK_WINDOW_DAYS,
              limitAuthors: env.X_PLAYBOOK_MAX_AUTHORS,
              maxPerTick: env.X_PLAYBOOK_MAX_PER_TICK,
              samplePosts: env.X_PLAYBOOK_SAMPLE_POSTS,
              minPosts: env.X_PLAYBOOK_MIN_POSTS,
              staleDays: env.X_PLAYBOOK_STALE_DAYS,
            }).catch((err) =>
              log.warn(
                { instance: inst.id, err: (err as Error).message },
                "engagement analyst failed (ignored)",
              ),
            );
          }
        }

        // Work-queue read first: most ticks find nothing, because profiles stay
        // valid for PROFILE_REFRESH_DAYS. The watchlist half is an index-only read;
        // the reply half is a grouped join over approvals+drafts+leads (~60ms at
        // current volume) and runs once per PROFILER_POLL_MS.
        //
        // Two lanes: the watchlist (people we chose) and anyone we've actually
        // SENT more than PROFILER_MIN_REPLIES replies to. The second backstops
        // the holes in auto-promote — a person removed from the watchlist keeps
        // an orphaned profile that would otherwise never refresh again.
        const [watchlist, replied] = await Promise.all([
          listWatchlistPeopleNeedingProfile(sql, {
            agentInstanceId: inst.id,
            staleDays: env.PROFILE_REFRESH_DAYS,
            batch: env.PROFILER_BATCH,
          }),
          listRepliedPeopleNeedingProfile(sql, {
            agentInstanceId: inst.id,
            minReplies: env.PROFILER_MIN_REPLIES,
            windowDays: env.PROFILER_REPLY_WINDOW_DAYS,
            staleDays: env.PROFILE_REFRESH_DAYS,
            batch: env.PROFILER_BATCH,
          }).catch((err) => {
            // Never let the newer lane take the established one down.
            log.warn({ instance: inst.id, err: (err as Error).message }, "replied-people queue failed");
            return [];
          }),
        ]);
        const people = mergeProfilerQueue({ watchlist, replied, batch: env.PROFILER_BATCH });
        if (people.length === 0) {
          await run.finish({ status: "ok", rowsProcessed: 0 });
          return;
        }

        const apify = await resolveApify(inst.org_id);
        if (!apify) {
          await run.finish({ status: "ok", rowsProcessed: 0 });
          return;
        }

        const profiled = await runProfilerTick({
          log,
          instance: inst,
          people,
          xClient: apify.client,
          runner,
          upsertProfile: (p) => upsertWatchlistProfile(sql, p),
          markAttempted: (a) => markProfileAttempted(sql, a),
          rateBucket: bucket,
          recorder,
          credentialId: apify.credentialId,
        });
        await run.finish({ status: "ok", rowsProcessed: profiled });
      } catch (err) {
        if (err instanceof AllApifyTokensExhaustedError) {
          log.error({ org_id: inst.org_id, tokens: err.tokenCount }, "all apify tokens exhausted");
          await run.finish({ status: "error", errorMessage: err.message });
          return;
        }
        await run.finish({ status: "error", errorMessage: (err as Error).message });
        throw err;
      }
    },
    shouldStop,
  });
}

main().catch((err) => {
  console.error("profiler fatal:", err);
  process.exit(EX_TEMPFAIL);
});
