import { loadEnv } from "../env.js";
import { createLogger } from "../lib/logger.js";
import { noelleDb } from "../lib/db.js";
import { listProfilerLinkedinInternInstances, isWorkerEnabled } from "../lib/activation.js";
import { recordRun } from "../lib/worker-runs.js";
import { busForInstance } from "../lib/bus.js";
import { runBootChecks, EX_TEMPFAIL } from "../lib/boot.js";
import { createSecretsClient, SecretAccessError, APIFY_TOKEN_SECRET_ID } from "../lib/secrets.js";
import { withinActiveHours } from "../lib/cadence.js";
import { ApifyError } from "@noelle/linkedin-apify";
import { createCodexRunner } from "../lib/codex-runner.js";
import { createPgSpendRecorder } from "@noelle/runtime/pg-spend-recorder";
import { createApifyResolver } from "../lib/apify-resolver.js";
import { createPgBudgetAdapters, CAP_EXEMPT_ENGINES_APIFY } from "@noelle/runtime/pg-budget-adapters";
import { createBedrockBackend, createClaudeCliBackend } from "@noelle/runtime";
import type { EngineBackend, CreateClaudeCliBackendOptions } from "@noelle/runtime";
import {
  listWatchlistPeopleNeedingProfile,
  listRepliedPeopleNeedingProfile,
  upsertWatchlistProfile,
  markProfileAttempted,
} from "../lib/watchlist-db.js";
import { buildProfilerQueue } from "../lib/profiler-queue.js";
import { runWorkerLoop, installShutdown } from "./_runtime.js";
import { runProfilerTick } from "./profiler-tick.js";
import { runAnalystTick } from "./analyst-tick.js";
import { getWatchlistAuthorEngagement } from "../lib/leads-engagement-db.js";
import { getFreshPlaybookAuthors, upsertPlaybook } from "../lib/playbooks-db.js";

async function main() {
  const env = loadEnv();
  const log = createLogger({ kind: "profiler", workerId: env.WORKER_ID });
  const sql = noelleDb();
  const secrets = createSecretsClient({ project: env.GCP_PROJECT });

  // Apify posts transport (no LinkedIn cookies). Token from the org's ACTIVE
  // noelle.connections row (hot-swappable in the dashboard), env/SM fallback.
  const resolveApify = createApifyResolver({
    sql,
    secrets,
    apifyTokenSecretId: APIFY_TOKEN_SECRET_ID,
    profilePostsActorId: env.APIFY_PROFILE_POSTS_ACTOR_ID,
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

  // Register the local Claude subscription so callAgentModel rewrites BOTH the
  // bedrock primary and fallback to claude-cli (flat-rate, ~$0) when the org is
  // on llm_backend='claude'. Without this the rewrite silently no-ops and the
  // profiler bills Bedrock — the leak this closes. Mirrors the x-intern profiler.
  if (process.env.NOELLE_CLAUDE_CLI === "1") {
    const cliOpts: CreateClaudeCliBackendOptions = {};
    if (process.env.NOELLE_CLAUDE_CLI_PATH) cliOpts.cliPath = process.env.NOELLE_CLAUDE_CLI_PATH;
    if (process.env.NOELLE_CLAUDE_CLI_TIMEOUT_MS) {
      cliOpts.timeoutMs = Number(process.env.NOELLE_CLAUDE_CLI_TIMEOUT_MS);
    }
    engines["claude-cli"] = createClaudeCliBackend(cliOpts);
    log.info({}, "claude-cli backend ready");
  }

  const recorder = createPgSpendRecorder(sql);
  const runner = createCodexRunner({
    engines,
    sql,
    budget: { adapters: createPgBudgetAdapters(sql, { exemptEngines: CAP_EXEMPT_ENGINES_APIFY }) },
    recorder,
  });

  log.info({}, "linkedin profiler worker ready");
  const shouldStop = installShutdown(log);

  await runWorkerLoop({
    log,
    kind: "profiler",
    pollMs: env.PROFILER_POLL_MS,
    idlePollMs: env.IDLE_POLL_MS,
    listActive: () => listProfilerLinkedinInternInstances(sql),
    onTick: async (inst) => {
      // Per-instance gate (0024). The profiler is decoupled from Start/Pause —
      // its selector returns paused instances too — so this flag is the only
      // switch: an operator can run profiling alone while the pipeline is off.
      if (!isWorkerEnabled(inst, "profiler")) {
        log.debug({ instance: inst.id }, "profiler disabled for instance; skipping");
        return;
      }
      // Human-hours gate: profiling deep-reads posts; keep it in waking hours.
      if (!withinActiveHours(env)) {
        log.debug({ instance: inst.id }, "outside active hours; skipping linkedin profiler");
        return;
      }
      const bus = busForInstance(inst);
      const run = await recordRun({ sql, kind: "profiler", bus });
      try {
        // Work-queue read first: most ticks find nothing, because profiles stay
        // valid for PROFILE_REFRESH_DAYS. The watchlist half is an index-only read;
        // the reply half is a grouped join over approvals+drafts+leads (~60ms at
        // current volume) and runs once per PROFILER_POLL_MS.
        //
        // Two lanes feed the queue. The watchlist is the people the operator chose; the
        // reply lane is the people Lyra actually talks to (> PROFILER_MIN_REPLIES
        // SENT replies), who otherwise never got profiled at all — the search
        // lane meets them, the watchlist never hears about them, and every reply
        // to them was drafted with no idea who they are.
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
        const people = buildProfilerQueue({ watchlist, replied, batch: env.PROFILER_BATCH });
        if (replied.length > 0) {
          log.info(
            { instance: inst.id, watchlist: watchlist.length, replied: replied.length, queued: people.length },
            "profiler queue includes high-reply authors",
          );
        }

        let profiled = 0;
        if (people.length > 0) {
          const apify = await resolveApify(inst.org_id);
          if (apify) {
            profiled = await runProfilerTick({
              log,
              instance: inst,
              people,
              postsSource: apify.client,
              runner,
              postLimit: env.LINKEDIN_PROFILER_LIMIT,
              upsertProfile: (p) => upsertWatchlistProfile(sql, p),
              markAttempted: (a) => markProfileAttempted(sql, a),
              recorder,
              credentialId: apify.credentialId,
            });
          }
        }

        // Engagement Analyst pass (Intelligence box). DB + LLM only — no Apify,
        // no LinkedIn cookies — so it runs every tick regardless of whether any
        // profile needed a refresh, ranking watched authors by real engagement
        // and distilling the top performers into reusable playbooks.
        let playbooks = 0;
        try {
          const ranked = await getWatchlistAuthorEngagement(sql, {
            agentInstanceId: inst.id,
            windowDays: env.LINKEDIN_ANALYST_WINDOW_DAYS,
            limitAuthors: env.LINKEDIN_ANALYST_TOP_AUTHORS,
            samplePosts: env.LINKEDIN_ANALYST_SAMPLE_POSTS,
            minPosts: env.LINKEDIN_ANALYST_MIN_POSTS,
          });
          if (ranked.length > 0) {
            const freshHandles = await getFreshPlaybookAuthors(sql, {
              orgId: inst.org_id,
              agentInstanceId: inst.id,
              platform: "linkedin",
              authorHandles: ranked.map((a) => a.authorHandle),
              staleDays: env.PROFILE_REFRESH_DAYS,
            });
            playbooks = await runAnalystTick({
              log,
              instance: inst,
