import { createNotifier } from "@noelle/runtime/notifier";
import { getVoiceExemplars } from "@noelle/runtime/prior-replies";
import { loadEnv } from "../env.js";
import { createLogger } from "../lib/logger.js";
import { noelleDb } from "../lib/db.js";
import { listActiveOrPausedLinkedinInternInstances, isWorkerEnabled } from "../lib/activation.js";
import { effectiveDraftsCap, enforceGoal, goalTarget } from "../lib/goal.js";
import { recordRun } from "../lib/worker-runs.js";
import { busForInstance } from "../lib/bus.js";
import { runBootChecks, EX_TEMPFAIL } from "../lib/boot.js";
import { createSecretsClient, SecretAccessError, APIFY_TOKEN_SECRET_ID } from "../lib/secrets.js";
import { createReadyCache } from "@noelle/runtime/ready-cache";
import { withMeteredApifyCall } from "@noelle/runtime/apify-metering";
import { createApifyResolver } from "../lib/apify-resolver.js";
import type { LinkedInComment } from "@noelle/linkedin-apify";
import {
  claimLeadsForDrafting,
  claimWatchlistLeadsForDrafting,
  claimNotificationLeadsForDrafting,
  claimObservedLeadsForDrafting,
  claimDmRequestLeads,
  claimReplyRequestLeads,
  countDraftedTodayByKind,
  countPendingApprovalsForInstance,
  createStartupDraftingRecovery,
  markLeadStatus,
  reapStaleClaims,
  type LeadRow,
} from "../lib/leads-db.js";
import { createCodexRunner } from "../lib/codex-runner.js";
import { createOutboundClient } from "@noelle/runtime/outbound-client";
import { claimIntroDmPeople } from "../lib/watchlist-db.js";
import { getRecentRepliesToAuthor, getRecentReplyPhrasings } from "../lib/prior-replies-db.js";
import { runRelationshipDmsForInstance } from "../lib/relationship-dms.js";
import {
  listStyleExemplars,
  listUltraProfiles,
  listStyleExemplarsForHandle,
  getUltraProfileForHandle,
} from "../lib/account-feeder-db.js";
import { readFaithfulVoices, readFaithfulVoiceWeights, readStyleExemplarKinds, pinnedSelectConfig } from "@noelle/runtime";
import { AccountFeederConfigSchema } from "@noelle/contracts";
import { runWorkerLoop, installShutdown } from "./_runtime.js";
import { runDrafterTick, runDmRequestTick, runIntroDmTick } from "./drafter-tick.js";
import { runPatternBreakerTick, runPatternRefineTick } from "./pattern-breaker-tick.js";
import {
  loadRecentPosts,
  loadActiveRuleLabels,
  loadActivePatternRules,
  loadRefiningAlerts,
  persistPattern,
  applyRefinedRule,
  claimRefinement,
} from "../lib/pattern-breaker-db.js";
import {
  createNellaClient,
  createGcsNellaClientWithSdk,
  createLocalFsKnowledgeBase,
  knowledgeBaseFromNella,
  parseIncludeDirs,
  buildEngineRegistry,
  createGeminiCaptionFn,
  createVertexCaptionFn,
  createBedrockCaptionFn,
} from "@noelle/runtime";
import type { KnowledgeBase, CaptionFn, VerifierCall } from "@noelle/runtime";
import { judgeRouting } from "../lib/routing.js";
import { createPgSpendRecorder } from "@noelle/runtime/pg-spend-recorder";
import { createPgBudgetAdapters, CAP_EXEMPT_ENGINES_APIFY } from "@noelle/runtime/pg-budget-adapters";
import { createWakeGate } from "../lib/wake-gate.js";
import { planDraftLanes } from "../lib/draft-lanes.js";
import { cleanupPrivateReviewTraces } from "../lib/private-review-trace.js";

// How many approved POST -> REPLY pairs to show the drafter. 0 disables the
// block and restores the previous prompt exactly.
const VOICE_EXEMPLAR_COUNT = Number(process.env.NOELLE_VOICE_EXEMPLARS ?? 6);

async function main() {
  const startedAt = new Date();
  const env = loadEnv();
  const log = createLogger({ kind: "drafter", workerId: env.WORKER_ID });
  await cleanupPrivateReviewTraces().catch(() => log.warn({}, "private review trace cleanup failed"));
  const sql = noelleDb();
  const recoverStartupClaims = createStartupDraftingRecovery(sql, startedAt);
  const secrets = createSecretsClient({ project: env.GCP_PROJECT });
  // Per-org Pushover dispatcher for notification pins (triage verdict "pin").
  const notifier = createNotifier({ secrets, log });
  const readyCache = createReadyCache();

  const boot = await runBootChecks({
    log,
    checks: [
      { name: "db.ping", kind: "transient", run: async () => { await sql`select 1 as ok`; } },
    ],
  });
  if (!boot.ok) process.exit(boot.exitCode);

  // Assemble the engine registry from whatever provider credentials this box has
  // (Bedrock / Anthropic-direct / OpenAI-direct / Vertex). On the self-host Lima
  // VM that's whichever key the operator configured. Empty registry → a lead
  // fails loudly with EngineNotImplementedError on the first tick.
  const engines = await buildEngineRegistry({
    secrets,
    log: (msg, meta) => log.info(meta ?? {}, msg),
  });
  if (Object.keys(engines).length === 0) {
    log.warn(
      {},
      "no LLM provider credentials configured (Anthropic / OpenAI / Bedrock / Vertex); drafter will fail every tick until one is provisioned",
    );
  }

  const recorder = createPgSpendRecorder(sql);
  const budget = { adapters: createPgBudgetAdapters(sql, { exemptEngines: CAP_EXEMPT_ENGINES_APIFY }) };
  const runner = createCodexRunner({
    engines,
    sql,
    budget,
    recorder,
  });
  const outbound = createOutboundClient({ baseUrl: env.CP_BASE_URL, hmacSecret: env.NOELLE_HMAC_SECRET });

  // Comment-energy: the drafter reads the existing comments on a post (Apify
  // post-comments actor) so its reply matches the room and doesn't echo the
  // crowd. The token is resolved per tick from the org's ACTIVE connection
  // (hot-swappable in the dashboard, env/SM fallback); a missing token just
  // disables comment-energy and the drafter falls back to no comment context.
  const resolveApify =
    env.LINKEDIN_DRAFTER_COMMENT_MAX > 0
      ? createApifyResolver({ sql, secrets, apifyTokenSecretId: APIFY_TOKEN_SECRET_ID, log })
      : null;

  // Knowledge base — the drafter's voice/anchor retrieval. `local` (self-host
  // default) reads markdown from a local dir and BM25-ranks in-process. `gcs`
  // (managed) wraps the GCS shim. `http` (legacy) wraps the per-org Nella HTTP
  // client and is built per-tick because it needs a per-org key.
  const kbBackend = env.NOELLE_KB_BACKEND ?? env.NOELLE_NELLA_BACKEND;
  const kbWorkspace = env.NELLA_WORKSPACE;
  let sharedKb: KnowledgeBase | null = null;
  if (kbBackend === "gcs") {
    const gcs = await createGcsNellaClientWithSdk({ bucket: env.NOELLE_VAULT_BUCKET });
    sharedKb = knowledgeBaseFromNella(gcs, kbWorkspace);
    log.info({ backend: "gcs", bucket: env.NOELLE_VAULT_BUCKET }, "knowledge base ready (gcs)");
  } else if (kbBackend === "local") {
    if (!env.NOELLE_VAULT_DIR) {
      throw new Error("NOELLE_KB_BACKEND=local requires NOELLE_VAULT_DIR");
    }
    // Scope retrieval to the curated voice base when configured, so Lyra grounds
    // on the operator's voice — not earnings reports / leaked prompts that happen
    // to share keywords with the post. Unset → whole-vault (back-compat).
    const voiceDirs = parseIncludeDirs(env.NOELLE_VOICE_DIRS);
    const knowledgeDirs = parseIncludeDirs(env.NOELLE_KNOWLEDGE_DIRS);
    // Index voice AND knowledge dirs so the drafter's second (knowledge) pass
    // has something to retrieve on the local backend; search-time filterDirs
    // then separates the two. Empty union → whole vault (back-compat).
    const includeDirs = [...new Set([...voiceDirs, ...knowledgeDirs])];
    sharedKb = createLocalFsKnowledgeBase({
      dir: env.NOELLE_VAULT_DIR,
      cacheTtlMs: env.NOELLE_KB_CACHE_TTL_MS,
      includeDirs,
    });
    log.info(
      {
        backend: "local",
        dir: env.NOELLE_VAULT_DIR,
        voiceDirs: voiceDirs.length ? voiceDirs : "(whole vault)",
        knowledgeDirs: knowledgeDirs.length ? knowledgeDirs : "(none)",
      },
      "knowledge base ready (local fs bm25)",
    );
  }

  log.info({}, "linkedin drafter worker ready");
  const shouldStop = installShutdown(log);
  const wake = createWakeGate();
  await sql.listen("noelle_linkedin_priority", () => wake.wake()).catch((err) =>
    log.warn({ err: (err as Error).message }, "priority lead wake unavailable; polling continues"),
  );

  await runWorkerLoop({
    log,
    kind: "drafter",
    pollMs: env.DRAFTER_POLL_MS,
    idlePollMs: env.IDLE_POLL_MS,
    listActive: () => listActiveOrPausedLinkedinInternInstances(sql),
    onTick: async (inst) => {
      const postOutbound = (body: Parameters<typeof outbound.postOutbound>[0]) =>
        outbound.postOutbound(body, { orgId: inst.org_id, agentInstanceId: inst.id });
      // The notifications lane is independent of the cold drafter lane: turning
      // cold drafting OFF must not stop us answering people who replied to us.
      const notifLaneOn = isWorkerEnabled(inst, "notifications");
      const drafterLaneOn = isWorkerEnabled(inst, "drafter");
      // Answer replies ONLY, leaving cold outbound dead, when either switch says
      // so: the cold drafter lane is off, or the instance is paused and the
      // always-on watchlist lane is off too.
      const notificationsOnly =
        notifLaneOn &&
        (!drafterLaneOn ||
          (inst.status === "paused" && !isWorkerEnabled(inst, "watchlist")));
      const bus = busForInstance(inst);
