import { loadEnv } from "../env.js";
import { createLogger } from "../lib/logger.js";
import { noelleDb } from "../lib/db.js";
import { listWatchlistOrActiveXInternInstances, isWorkerEnabled } from "../lib/activation.js";
import { effectiveDraftsCap } from "../lib/goal.js";
import { recordRun } from "../lib/worker-runs.js";
import { busForInstance } from "../lib/bus.js";
import { runBootChecks, EX_TEMPFAIL } from "../lib/boot.js";
import { createSecretsClient, SecretAccessError } from "../lib/secrets.js";
import { createClassifier } from "../lib/classifier-engine.js";
import { resolveClassifierModel } from "@noelle/runtime/classifier-routing";
import {
  createGeminiKeyBackend,
  createBudgetedBackend,
  buildEngineRegistry,
  batchMap,
  isBudgetAdmissionError,
} from "@noelle/runtime";
import type { EngineBackend } from "@noelle/runtime";
import { selectGeminiBackend } from "@noelle/runtime/gemini-backend-select";
import { createCodexRunner } from "../lib/codex-runner.js";
import type { CodexRunner } from "../lib/codex-runner.js";
import { createPgSpendRecorder } from "@noelle/runtime/pg-spend-recorder";
import { createPgBudgetAdapters, CAP_EXEMPT_ENGINES_APIFY_XAPI } from "@noelle/runtime/pg-budget-adapters";
import {
  claimLeadsForClassification,
  releaseClassificationClaims,
  CLASSIFICATION_BATCH_LIMIT,
  claimObservedLeadsForClassification,
  countPendingApprovalsForInstance,
  reapStaleClaims,
} from "../lib/leads-db.js";
import { runWorkerLoop, installShutdown } from "./_runtime.js";
import { createNotifier } from "@noelle/runtime/notifier";
import { classifyOneLead, classifierBudgetBlock } from "./classifier-tick.js";
import type { BatchClassifyResult, ClassifyOutput } from "../lib/classifier-engine.js";
import { createWakeGate } from "../lib/wake-gate.js";
import { classificationEligibility } from "../lib/classification-eligibility.js";

// One `claude -p` spawn per lead pays a fixed toll — ~2,000 tokens of CLI
// scaffolding plus the classifier prompt — before it reads a single post.
// Measured on 20 real leads: one spawn each cost 58,900 input tokens; ten leads
// in one spawn cost 9,529 for the same work, with no drop in agreement against
// production verdicts. The leads are already claimed as a batch; this just stops
// fanning them out into separate processes.
// Set NOELLE_CLASSIFIER_BATCH=0 to go back to one call per lead.
const CLASSIFIER_BATCH = process.env.NOELLE_CLASSIFIER_BATCH !== "0";

// Relationship scout: flag high-leverage authors + pre-draft an intro DM in the
// classifier's existing call. On by default; set NOELLE_VIP_SCOUT=false (or 0)
// to disable. Additive + fail-open, so leaving it on is safe.
const VIP_SCOUT_ENABLED =
  process.env.NOELLE_VIP_SCOUT !== "false" &&
  process.env.NOELLE_VIP_SCOUT !== "0";

// Latency knob: how many leads in a claimed batch run on the local claude -p
// subscription CONCURRENTLY (a bounded worker pool via batchMap). Default 4;
// raise for more throughput, lower to ease pressure on the subscription. The
// batch no longer overflows to Bedrock — overflow leads simply wait for a free
// slot. Other backends run at most the ten claimed posts together.
// Subscription usage retains admission and measured accounting.
const CLI_CONCURRENCY = Math.max(
  1,
  Number(process.env.NOELLE_CLASSIFIER_CLI_CONCURRENCY) || 4,
);

async function main() {
  const env = loadEnv();
  const log = createLogger({ kind: "classifier", workerId: env.WORKER_ID });
  const sql = noelleDb();
  const secrets = createSecretsClient({ project: env.GCP_PROJECT });

  // Noelle-billed scoring backend, chosen by NOELLE_CLASSIFIER_BACKEND:
  //   - "vertex" (default, managed prod): direct Gemini when
  //     NOELLE_GEMINI_API_KEY is set, otherwise Vertex AI via SA/ADC. Model is
  //     the per-instance override or Gemini Flash.
  //   - "bedrock" (self-host VM): Bedrock Claude via the worker's AWS keys.
  //     The self-host box can't use Vertex (user-ADC dies with invalid_rapt),
  //     so we classify on Bedrock with a cheap Claude (Haiku). The
  //     classifier engine is backend-agnostic (strict-JSON parse), so Claude
  //     works in place of Gemini.
  // An org that brings its own Gemini key (see below) overrides either, billing
  // its own Google account. Constructed once at boot.
  const billedEngine: "vertex" | "bedrock" = env.NOELLE_CLASSIFIER_BACKEND;
  // Engine recorded to noelle.llm_calls for the Noelle-billed path. Starts at
  // the configured billedEngine; the bedrock branch flips it to "claude-cli"
  // when it routes classification through the local subscription (below).
  let recordEngine: "vertex" | "bedrock" | "claude-cli" = billedEngine;
  let noelleBackend: EngineBackend;
  // Fixed model for the bedrock/claude-cli path; null on vertex (resolved
  // per-tick from the instance override, falling back to Gemini Flash).
  let bedrockModel: string | null = null;
  if (billedEngine === "bedrock") {
    const registry = await buildEngineRegistry({
      secrets,
      enable: { bedrock: true, vertex: false, claude: false, openai: false },
      log: (msg, meta) => log.info(meta ?? {}, msg),
    });
    bedrockModel = env.NOELLE_CLASSIFIER_BEDROCK_MODEL;
    // Route the Noelle-billed classifier through the local Claude subscription
    // (claude -p) when it's wired (NOELLE_CLAUDE_CLI=1, so
    // buildEngineRegistry also registered claude-cli). Bedrock is NO LONGER a
    // fallback: a hard CLI failure fails that lead open (it stays 'new' and is
    // re-claimed next tick) rather than silently billing AWS. Bedrock is used
    // only where claude-cli isn't wired (e.g. a managed box without the CLI).
    const cli = registry["claude-cli"];
    if (cli) {
      noelleBackend = cli;
      recordEngine = "claude-cli";
      log.info({ model: bedrockModel }, "classifier backend: claude-cli (no bedrock fallback)");
    } else if (registry.bedrock) {
      noelleBackend = registry.bedrock;
      log.info({ model: bedrockModel }, "classifier backend: bedrock (claude)");
    } else {
      throw new Error(
        "NOELLE_CLASSIFIER_BACKEND=bedrock but neither claude-cli nor Bedrock is wired",
      );
    }
  } else {
    noelleBackend = selectGeminiBackend({
      apiKey: env.NOELLE_GEMINI_API_KEY,
      gcpProject: env.GCP_PROJECT,
    });
    log.info(
      { geminiKey: !!env.NOELLE_GEMINI_API_KEY },
      env.NOELLE_GEMINI_API_KEY
        ? "classifier backend: gemini-key (generativelanguage API)"
        : "classifier backend: vertex (gemini, ADC)",
    );
  }
  const budgetAdapters = createPgBudgetAdapters(sql, { exemptEngines: CAP_EXEMPT_ENGINES_APIFY_XAPI });
  const spendRecorder = createPgSpendRecorder(sql);

  // VIP intro DM drafter: Opus (claude -p → Bedrock), the same engine path the
  // reply drafter uses — NOT the classifier's gemini-flash. The scout decides who
  // gets a DM; this runner writes it so it reads human. Built once; gated on the
  // scout. An empty registry (no bedrock/cli creds, e.g. a managed Vertex box) →
  // null, and DM drafting fails open (the VIP is still flagged, just no DM).
  let vipDmRunner: CodexRunner | null = null;
  if (VIP_SCOUT_ENABLED) {
    const dmEngines = await buildEngineRegistry({
      secrets,
      log: (msg, meta) => log.info(meta ?? {}, msg),
    });
    if (Object.keys(dmEngines).length > 0) {
      vipDmRunner = createCodexRunner({
        engines: dmEngines,
        sql,
        budget: { adapters: budgetAdapters },
        recorder: spendRecorder,
      });
      log.info({ engines: Object.keys(dmEngines) }, "vip intro DM drafter ready (opus)");
    } else {
      log.warn({}, "vip scout on but no LLM engines available; intro DMs will be skipped");
    }
  }

  const boot = await runBootChecks({
    log,
    checks: [
      { name: "db.ping", kind: "transient", run: async () => { await sql`select 1 as ok`; } },
    ],
  });
  if (!boot.ok) process.exit(boot.exitCode);

  const notifier = createNotifier({ secrets, log });
  log.info({}, "classifier worker ready");
  const shouldStop = installShutdown(log);
  const jevRetryAfter = new Map<string, number>();
  const wake = createWakeGate();
  await sql.listen("noelle_x_observed", () => wake.wake()).catch((err) =>
    log.warn({ err: (err as Error).message }, "observed X wake unavailable; polling continues"),
  );

  await runWorkerLoop({
    log,
    kind: "classifier",
    pollMs: env.CLASSIFIER_POLL_MS,
    idlePollMs: env.IDLE_POLL_MS,
    listActive: () => listWatchlistOrActiveXInternInstances(sql),
    onTick: async (inst) => {
      const meteredBackend = createBudgetedBackend(noelleBackend, {
        engine: recordEngine,
        context: { orgId: inst.org_id, instanceId: inst.id, agentRole: "x_intern", worker: "classifier", bucket: "classifier" },
        budget: { adapters: budgetAdapters }, recorder: spendRecorder,
      });
      // Two lanes: the watchlist lane (priority leads) is always-on while
      // watchlist_enabled and bypasses the backpressure cap; the keyword lane
      // (any lead) runs only when active + classifier_enabled and respects it.
      const active = inst.status !== "paused";
      const watchlistLaneOn = isWorkerEnabled(inst, "watchlist");
      const keywordLaneOn = active && isWorkerEnabled(inst, "classifier");
      if (!watchlistLaneOn && !keywordLaneOn) {
        log.debug({ instance: inst.id }, "classifier: both lanes off; skipping");
        return;
      }
      const bus = busForInstance(inst);
      const run = await recordRun({ sql, kind: "classifier", bus });
      try {
        // Recover leads stranded at 'classifying' by a crash/restart mid-claim —
