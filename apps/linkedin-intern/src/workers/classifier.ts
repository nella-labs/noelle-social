import { loadEnv } from "../env.js";
import { createLogger } from "../lib/logger.js";
import { noelleDb } from "../lib/db.js";
import { listActiveOrPausedLinkedinInternInstances, isWorkerEnabled } from "../lib/activation.js";
import { effectiveDraftsCap, enforceGoal } from "../lib/goal.js";
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
} from "@noelle/runtime";
import type { EngineBackend } from "@noelle/runtime";
import { createCodexRunner } from "../lib/codex-runner.js";
import type { CodexRunner } from "../lib/codex-runner.js";
import { selectGeminiBackend } from "@noelle/runtime/gemini-backend-select";
import { createPgSpendRecorder } from "@noelle/runtime/pg-spend-recorder";
import { createPgBudgetAdapters, CAP_EXEMPT_ENGINES_APIFY } from "@noelle/runtime/pg-budget-adapters";
import {
  claimLeadsForClassification,
  claimObservedLeadsForClassification,
  countPendingApprovalsForInstance,
  reapStaleClaims,
} from "../lib/leads-db.js";
import { runWorkerLoop, installShutdown } from "./_runtime.js";
import { createNotifier } from "@noelle/runtime/notifier";
import { classifyOneLead, classifierBudgetBlock } from "./classifier-tick.js";
import { createWakeGate } from "../lib/wake-gate.js";

// Relationship scout: flag high-leverage authors + pre-draft an intro DM in the
// classifier's existing call. On by default; set NOELLE_VIP_SCOUT=false (or 0)
// to disable. Additive + fail-open, so leaving it on is safe.
const VIP_SCOUT_ENABLED =
  process.env.NOELLE_VIP_SCOUT !== "false" &&
  process.env.NOELLE_VIP_SCOUT !== "0";

async function main() {
  const env = loadEnv();
  const log = createLogger({ kind: "classifier", workerId: env.WORKER_ID });
  const sql = noelleDb();
  const secrets = createSecretsClient({ project: env.GCP_PROJECT });

  // Noelle-billed scoring backend, chosen by NOELLE_CLASSIFIER_BACKEND:
  //   - "vertex" (default, managed prod): Vertex AI Gemini via the worker's ADC.
  //     When NOELLE_GEMINI_API_KEY is also set, uses createGeminiKeyBackend instead
  //     (hits generativelanguage.googleapis.com — no ADC token, no reauth wall).
  //     This is the self-host Lima VM escape hatch for the `invalid_rapt` error.
  //   - "bedrock" (self-host Lima VM): Bedrock Claude via the worker's AWS keys.
  // A BYO org gemini-api-key still overrides either, billing its own account.
  const billedEngine: "vertex" | "bedrock" = env.NOELLE_CLASSIFIER_BACKEND;
  // Engine recorded to noelle.llm_calls for the Noelle-billed path. The bedrock
  // branch flips it to "claude-cli" when it routes through the local subscription.
  let recordEngine: "vertex" | "bedrock" | "claude-cli" = billedEngine;
  let noelleBackend: EngineBackend;
  // Fixed model on the bedrock/claude-cli path; null on vertex (resolved per-tick).
  let bedrockModel: string | null = null;
  if (billedEngine === "bedrock") {
    const registry = await buildEngineRegistry({
      secrets,
      enable: { bedrock: true, vertex: false, claude: false, openai: false },
      log: (msg, meta) => log.info(meta ?? {}, msg),
    });
    bedrockModel = env.NOELLE_CLASSIFIER_BEDROCK_MODEL;
    // Prefer the local Claude subscription (claude -p, flat-rate ~$0) when it's
    // wired (NOELLE_CLAUDE_CLI=1, so buildEngineRegistry also registered
    // claude-cli). Bedrock is used only where the CLI isn't wired, and is NOT a
    // fallback — a hard CLI failure fails the lead open (re-claimed next tick)
    // rather than silently billing AWS.
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
    // Vertex path: uses NOELLE_GEMINI_API_KEY when set (no ADC, no reauth) or
    // falls back to Vertex AI + ADC for managed prod. See @noelle/runtime/gemini-backend-select.
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
  const budgetAdapters = createPgBudgetAdapters(sql, { exemptEngines: CAP_EXEMPT_ENGINES_APIFY });
  const spendRecorder = createPgSpendRecorder(sql);

  // VIP intro DM drafter: Opus (claude -p → Bedrock), the same engine path Lyra's
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
  log.info({}, "linkedin classifier worker ready");
  const shouldStop = installShutdown(log);
  const jevRetryAfter = new Map<string, number>();
  const wake = createWakeGate();
  await sql.listen("noelle_linkedin_observed", () => wake.wake()).catch((err) =>
    log.warn({ err: (err as Error).message }, "observed lead wake unavailable; polling continues"),
  );

  await runWorkerLoop({
    log,
    kind: "classifier",
    pollMs: env.CLASSIFIER_POLL_MS,
    idlePollMs: env.IDLE_POLL_MS,
    listActive: () => listActiveOrPausedLinkedinInternInstances(sql),
    onTick: async (inst) => {
      const meteredBackend = createBudgetedBackend(noelleBackend, {
        engine: recordEngine,
        context: { orgId: inst.org_id, instanceId: inst.id, agentRole: "linkedin_intern", worker: "classifier", bucket: "classifier" },
        budget: { adapters: budgetAdapters }, recorder: spendRecorder,
      });
      // Two-lane gate (mirrors discovery). The always-on WATCHLIST lane keeps
      // scoring watched-connection leads while the instance is paused so the
      // funnel keeps feeding the drafter; the active FUNNEL lane runs the normal
      // goal-driven pipeline. The per-worker classifier flag is honoured in both
      // states. Skip when paused-with-watchlist-off, or the classifier is off.
      const active = inst.status !== "paused";
      if ((!active && !isWorkerEnabled(inst, "watchlist")) || !isWorkerEnabled(inst, "classifier")) {
        log.debug({ instance: inst.id }, "classifier: paused with watchlist off, or disabled; skipping");
        return;
      }
      const bus = busForInstance(inst);
      const run = await recordRun({ sql, kind: "classifier", bus });
      try {
        // Recover leads stranded at 'classifying' by a crash/restart mid-claim —
        // without this they are invisible to every future claim (see reapStaleClaims).
        const reaped = await reapStaleClaims(sql, {
          agentInstanceId: inst.id,
          claimedStatus: "classifying",
          requeueStatus: "new",
        });
        if (reaped.requeued || reaped.expired) {
          log.warn({ org_id: inst.org_id, ...reaped }, "reaped stale classifying claims");
        }
        const observedReaped = await reapStaleClaims(sql, {
          agentInstanceId: inst.id,
          claimedStatus: "observed_classifying",
          requeueStatus: "observed",
        });
        if (observedReaped.requeued || observedReaped.expired) {
          log.warn({ org_id: inst.org_id, ...observedReaped }, "reaped stale observed claims");
        }
        // Goal auto-stop: pause the pipeline once a goal-run produced its N
        // approvals. Cheap index-only count before any LLM call.
        const goal = await enforceGoal(sql, inst, { stallMs: env.LINKEDIN_GOAL_STALL_MIN * 60_000 });
        if (goal?.paused) {
          log.info(
            { org_id: inst.org_id, produced: goal.produced, target: goal.target, stalled: goal.stalled },
            goal.stalled
              ? "goal stalled (watchlist exhausted, no new leads) — pipeline paused"
              : "goal reached — pipeline paused",
          );
          await run.finish({ status: "ok", rowsProcessed: 0 });
          return;
        }

