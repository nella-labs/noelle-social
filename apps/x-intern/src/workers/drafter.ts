import { loadEnv } from "../env.js";
import { createLogger } from "../lib/logger.js";
import { noelleDb } from "../lib/db.js";
import { listWatchlistOrActiveXInternInstances, isWorkerEnabled } from "../lib/activation.js";
import { effectiveDraftsCap, enforceGoal } from "../lib/goal.js";
import { recordRun } from "../lib/worker-runs.js";
import { busForInstance } from "../lib/bus.js";
import { runBootChecks, EX_TEMPFAIL } from "../lib/boot.js";
import { createSecretsClient, SecretAccessError, APIFY_TOKEN_SECRET_ID } from "../lib/secrets.js";
import { createNotifier } from "@noelle/runtime/notifier";

// How many approved POST -> REPLY pairs to show the drafter. Six measured as
// enough to move the register without crowding the prompt; 0 disables the block
// entirely and restores a byte-identical prompt.
const VOICE_EXEMPLAR_COUNT = Number(process.env.NOELLE_VOICE_EXEMPLARS ?? 6);
import { createReadyCache } from "@noelle/runtime/ready-cache";
import { createApifyResolver } from "../lib/apify-resolver.js";
import { X_SCRAPER_ACTOR } from "@noelle/x-apify";
import type { SiblingComment } from "@noelle/runtime/comment-digest";
import {
  claimLeadsForDrafting,
  claimWatchlistLeadsForDrafting,
  claimObservedLeadsForDrafting,
  claimDmRequestLeads,
  claimReplyRequestLeads,
  expireStaleClassifiedLeads,
  supersedeOlderPriorityLeads,
  countPendingApprovalsForInstance,
  markLeadStatus,
  WATCHLIST_PENDING_CAP,
  type LeadRow,
  reapStaleClaims,
} from "../lib/leads-db.js";
import { expireStaleApprovals } from "../lib/send-db.js";
import { createCodexRunner } from "../lib/codex-runner.js";
import { createOutboundClient } from "@noelle/runtime/outbound-client";
import { xInternRouting, judgeRouting } from "../lib/routing.js";
import { getRecentSentExamples } from "../lib/examples-db.js";
// Per-person + feed-wide reply memory (shared with Lyra via @noelle/runtime).
import {
  getRecentRepliesToAuthor,
  getRecentReplyPhrasings,
  getVoiceExemplars,
} from "@noelle/runtime/prior-replies";
import { resolveAutosendQuality } from "../lib/autosend-quality.js";
import { isRelationshipDmsLaneEnabled, runRelationshipDmsForInstance } from "../lib/relationship-dms.js";
import { runWorkerLoop, installShutdown } from "./_runtime.js";
import { runDrafterTick, runDmRequestTick } from "./drafter-tick.js";
import { runPatternBreakerTick, runPatternRefineTick } from "./pattern-breaker-tick.js";
import {
  loadRecentPosts,
  loadActiveRuleLabels,
  loadActivePatternRules,
  loadRefiningAlerts,
  applyRefinedRule,
  claimRefinement,
  persistPattern,
} from "../lib/pattern-breaker-db.js";
import {
  readFaithfulVoices,
  createNellaClient,
  createGcsNellaClientWithSdk,
  createLocalFsKnowledgeBase,
  knowledgeBaseFromNella,
  parseIncludeDirs,
  buildEngineRegistry,
  createGeminiCaptionFn,
  createBedrockCaptionFn,
  type VerifierCall,
} from "@noelle/runtime";
import type { KnowledgeBase, CaptionFn } from "@noelle/runtime";
import { createPgSpendRecorder } from "@noelle/runtime/pg-spend-recorder";
import { createPgBudgetAdapters, CAP_EXEMPT_ENGINES_APIFY_XAPI } from "@noelle/runtime/pg-budget-adapters";
import { createWakeGate } from "../lib/wake-gate.js";
import { withMeteredApifyCall } from "../lib/apify-receipts.js";

async function main() {
  const env = loadEnv();
  const log = createLogger({ kind: "drafter", workerId: env.WORKER_ID });
  const sql = noelleDb();
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

  // Assemble the engine registry from whatever provider credentials this box
  // has — Bedrock (AWS), Anthropic-direct (sk-ant), OpenAI-direct (sk-), and
  // Vertex (ADC, gated). On the managed VM that's Bedrock from the
  // noelle-worker-bedrock-aws-* secrets; on a self-host box it's whichever key
  // the operator configured. An empty registry means a lead will fail loudly
  // with EngineNotImplementedError on the first tick — the signal to provision
  // a key.
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

  const budget = { adapters: createPgBudgetAdapters(sql, { exemptEngines: CAP_EXEMPT_ENGINES_APIFY_XAPI }) };
  const recorder = createPgSpendRecorder(sql);
  const runner = createCodexRunner({
    engines,
    sql,
    budget,
    recorder,
  });
  const outbound = createOutboundClient({ baseUrl: env.CP_BASE_URL, hmacSecret: env.NOELLE_HMAC_SECRET });

  // Apify resolver + spend recorder for the sibling-comment "read the room" fetch
  // (NOELLE_DRAFTER_COMMENT_ENERGY). Built once, only when the feature is on — it
  // rotates the SAME shared token pool discovery uses, fails open when no token is
  // available, and meters each fetch as engine='apify' worker='drafter'. Null when
  // the feature is off so drafting is byte-identical to today.
  const resolveApify = env.NOELLE_DRAFTER_COMMENT_ENERGY
    ? createApifyResolver({ sql, secrets, apifyTokenSecretId: APIFY_TOKEN_SECRET_ID, log })
    : null;
  const siblingRecorder = resolveApify ? createPgSpendRecorder(sql) : null;

  // Knowledge base — the drafter's voice/anchor retrieval, decoupled from the
  // Nella framing. `local` (self-host default) reads markdown from a local dir
  // and BM25-ranks in-process with live new-info ingestion (no GCP). `gcs`
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
    // Scope retrieval to the curated voice base when configured, so the drafter
    // grounds on the operator's voice — not earnings reports / leaked prompts that
    // happen to share keywords with the post. Unset → whole-vault (back-compat).
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

  // Fail-CLOSED sanity warning: require-verify with the verifier itself off means
  // NO lead can ever produce a genuine verdict, so EVERY auto-send holds for
  // manual approval. That is the safe direction, but it silently disables
  // unattended posting — surface it loudly at boot so it's not mistaken for a bug.
  if (env.NOELLE_X_AUTOSEND_REQUIRE_VERIFY && !env.NOELLE_DRAFTER_VERIFY) {
    log.warn(
      {},
      "auto-send require-verify is ON but verifier is OFF — ALL auto-sends will hold for manual approval",
    );
  }

  log.info({}, "drafter worker ready");
  const shouldStop = installShutdown(log);
  const wake = createWakeGate();
  await sql.listen("noelle_x_priority", () => wake.wake()).catch((err) =>
    log.warn({ err: (err as Error).message }, "X priority drafter wake unavailable; polling continues"),
  );

  await runWorkerLoop({
    log,
    kind: "drafter",
    pollMs: env.DRAFTER_POLL_MS,
    idlePollMs: env.IDLE_POLL_MS,
    listActive: () => listWatchlistOrActiveXInternInstances(sql),
    onTick: async (inst) => {
      const postOutbound = (body: Parameters<typeof outbound.postOutbound>[0]) =>
        outbound.postOutbound(body, { orgId: inst.org_id, agentInstanceId: inst.id });
      // Two lanes:
