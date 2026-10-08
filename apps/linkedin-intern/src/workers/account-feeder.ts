import { loadEnv } from "../env.js";
import { createLogger } from "../lib/logger.js";
import { noelleDb } from "../lib/db.js";
import { busForInstance } from "../lib/bus.js";
import { runBootChecks, EX_TEMPFAIL } from "../lib/boot.js";
import { createSecretsClient, APIFY_TOKEN_SECRET_ID } from "../lib/secrets.js";
import { createApifyResolver } from "../lib/apify-resolver.js";
import { createPgSpendRecorder } from "@noelle/runtime/pg-spend-recorder";
import { createPgBudgetAdapters, CAP_EXEMPT_ENGINES_APIFY } from "@noelle/runtime/pg-budget-adapters";
import {
  assertWithinCap,
  createBudgetedBackend,
  BudgetExceededError,
  voyageEmbed,
  type EngineBackend,
} from "@noelle/runtime";
import { selectGeminiBackend } from "@noelle/runtime/gemini-backend-select";
import {
  listInstancesWithPendingFeederRun,
  listEnabledFeederSources,
  upsertStylePosts,
  getAccountCorpus,
  upsertAccountUltraProfile,
  markSourcePulled,
  markFeederRunComplete,
  recordFeederRun,
  listUnembeddedStylePosts,
  updateStylePostEmbeddings,
} from "../lib/account-feeder-db.js";
import { runWorkerLoop, installShutdown } from "./_runtime.js";
import { runAccountFeederTick, STYLE_EXTRACTOR_TIMEOUT_MS } from "./account-feeder-tick.js";

// The Account Feeder worker (Lyra-first). MANUALLY triggered + cost-gated: it
// runs ONLY for instances with a pending run flag (account_feeder_run_requested_at
// > account_feeder_last_run_at) — NOT the normal active/paused gate, so an
// operator can pull style even while the instance is paused. Per run it pulls
// each enabled source account's posts + authored comments via Apify, stores the
// style corpus, fans out Gemini extractors to build per-account ultra profiles,
// and stamps last_run_at to clear the flag. See
// docs/superpowers/specs/2026-06-19-account-feeder-design.md §7 F5.
//
// Mirrors profiler.ts (poll → Apify pull → LLM extract → direct-SQL upsert).

// Per-run cap estimate for the feeder bucket: a manual run fans out a handful of
// cheap Gemini Flash extractors (~1¢ each). Backpressure, not accounting — each
// call's real cost is recorded after it completes.
const FEEDER_RUN_ESTIMATE_CENTS = 20;

async function main() {
  const env = loadEnv();
  const log = createLogger({ kind: "feeder", workerId: env.WORKER_ID });
  const sql = noelleDb();
  const secrets = createSecretsClient({ project: env.GCP_PROJECT });

  // Apify posts/comments transport (no LinkedIn cookies). Token from the org's
  // ACTIVE noelle.connections row (hot-swap), env/SM fallback. Same resolver as
  // discovery/profiler.
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

  // Style extraction uses selectGeminiBackend: NOELLE_GEMINI_API_KEY → direct
  // generativelanguage.googleapis.com (no ADC reauth, works on Lima VM);
  // unset → Vertex ADC fallback (managed-prod path, same as before).
  const extractor: EngineBackend = selectGeminiBackend({
    apiKey: env.NOELLE_GEMINI_API_KEY,
    gcpProject: env.GCP_PROJECT,
    timeoutMs: STYLE_EXTRACTOR_TIMEOUT_MS,
  });
  const recorder = createPgSpendRecorder(sql);
  const budgetAdapters = createPgBudgetAdapters(sql, { exemptEngines: CAP_EXEMPT_ENGINES_APIFY });

  log.info({}, "linkedin account-feeder worker ready");
  const shouldStop = installShutdown(log);

  await runWorkerLoop({
    log,
    // The heartbeat is instance-bound and labelled 'linkedin_feeder';
    // _runtime's `kind` only labels the loop + idle log line.
    kind: "profiler",
    pollMs: env.FEEDER_POLL_MS,
    idlePollMs: env.IDLE_POLL_MS,
    // PENDING-RUN selector — NOT the active gate. Runs even while paused.
    listActive: () => listInstancesWithPendingFeederRun(sql),
    onTick: async (inst) => {
      const bus = busForInstance(inst);
      const run = await recordFeederRun(sql, inst.id);
      try {
        const sources = await listEnabledFeederSources(sql, inst.id);
        if (sources.length === 0) {
          log.info({ instance: inst.id }, "feeder run requested but no enabled sources; nothing to pull");
          await run.finish({ status: "ok", rowsProcessed: 0 });
          return;
        }

        // Cap pre-flight on the feeder bucket. A run at/over cap is recorded as a
        // (non-fatal) skip so the operator sees why nothing happened, and the run
        // flag is still cleared in finally (a re-run after raising the cap works).
        try {
          await assertWithinCap(
            { bucket: "feeder", orgId: inst.org_id, instanceId: inst.id, estimatedCents: FEEDER_RUN_ESTIMATE_CENTS },
            budgetAdapters,
          );
        } catch (capErr) {
          if (capErr instanceof BudgetExceededError) {
            log.warn({ instance: inst.id, err: capErr.message }, "feeder run blocked by budget cap");
            await bus
              .emit({
                topic: "feeder.blocked",
                worker: "feeder",
                severity: "warn",
                summary: `Account feeder run blocked: ${capErr.message}`,
                payload: { reason: "budget_cap" },
              })
              .catch(() => {});
            await run.finish({ status: "error", errorMessage: `budget cap: ${capErr.message}` });
            return;
          }
          throw capErr;
        }

        const apify = await resolveApify(inst.org_id);
        if (!apify) {
          // No Apify token anywhere → surface, don't silently no-op a paid run.
          log.error({ instance: inst.id }, "feeder run requested but no Apify token available");
          await bus
            .emit({
              topic: "feeder.error",
              worker: "feeder",
              severity: "error",
              summary: "Account feeder run failed: no Apify token configured",
              payload: { reason: "no_apify_token" },
            })
            .catch(() => {});
          await run.finish({ status: "error", errorMessage: "no apify token available" });
          return;
        }

        const result = await runAccountFeederTick({
          log,
          instance: inst,
          sources,
          apify: apify.client,
          extractor: createBudgetedBackend(extractor, {
            engine: "vertex",
            context: { orgId: inst.org_id, instanceId: inst.id, agentRole: "linkedin_intern", worker: "feeder", bucket: "feeder" },
            budget: { adapters: budgetAdapters }, recorder,
          }),
          upsertStylePosts: (rows) => upsertStylePosts(sql, rows),
          getCorpus: (a) => getAccountCorpus(sql, a),
          upsertUltraProfile: (p) => upsertAccountUltraProfile(sql, p),
          markSourcePulled: (id) => markSourcePulled(sql, id),
          // Dense-embed corpus rows (backfill + newly pulled) via Voyage so the
          // F4b hybrid ranker has the pgvector signal. Fail-open: voyageEmbed
          // returns [] without a VOYAGE_API_KEY and the embed pass no-ops.
          embed: (texts) => voyageEmbed(texts, { inputType: "document" }),
          listUnembeddedStylePosts: (id, limit) => listUnembeddedStylePosts(sql, id, limit),
          updateStylePostEmbeddings: (rows) => updateStylePostEmbeddings(sql, rows),
          postLimit: env.LINKEDIN_FEEDER_POST_LIMIT,
          commentLimit: env.LINKEDIN_FEEDER_COMMENT_LIMIT,
          concurrency: env.LINKEDIN_FEEDER_CONCURRENCY,
          recorder,
          credentialId: apify.credentialId,
        });

        if (result.quotaError) {
          // Apify quota/concurrency wall — SURFACE to the operator (errored run +
          // bus event), not swallowed. The corpus pulled before the wall persists.
          await bus
            .emit({
              topic: "feeder.error",
              worker: "feeder",
              severity: "error",
              summary: `Account feeder hit Apify quota: ${result.quotaError}`,
              payload: {
                reason: "apify_quota",
                sourcesPulled: result.sourcesPulled,
                corpusRows: result.corpusRows,
              },
            })
            .catch(() => {});
          await run.finish({
            status: "error",
            rowsProcessed: result.corpusRows,
            errorMessage: `apify quota: ${result.quotaError}`,
          });
          return;
        }
