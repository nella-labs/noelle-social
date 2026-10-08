import { loadEnv } from "../env.js";
import { createLogger } from "../lib/logger.js";
import { noelleDb } from "../lib/db.js";
import { listActiveRedditInternInstances, isWorkerEnabled } from "../lib/activation.js";
import { effectiveDraftsCap, enforceGoal } from "../lib/goal.js";
import { recordRun } from "../lib/worker-runs.js";
import { busForInstance } from "../lib/bus.js";
import { runBootChecks, EX_TEMPFAIL } from "../lib/boot.js";
import { createSecretsClient, SecretAccessError } from "../lib/secrets.js";
import { createClassifier } from "../lib/classifier-engine.js";
import { resolveClassifierModel } from "@noelle/runtime/classifier-routing";
import {
  createVertexBackend,
  createGeminiKeyBackend,
  createBudgetedBackend,
  buildEngineRegistry,
} from "@noelle/runtime";
import type { EngineBackend } from "@noelle/runtime";
import { createPgSpendRecorder } from "@noelle/runtime/pg-spend-recorder";
import { createPgBudgetAdapters, CAP_EXEMPT_ENGINES_APIFY } from "@noelle/runtime/pg-budget-adapters";
import {
  claimLeadsForClassification,
  countPendingApprovalsForInstance,
  reapStaleClaims,
} from "../lib/leads-db.js";
import { runWorkerLoop, installShutdown } from "./_runtime.js";
import { createNotifier } from "@noelle/runtime/notifier";
import { classifyOneLead, classifierBudgetBlock } from "./classifier-tick.js";

async function main() {
  const env = loadEnv();
  const log = createLogger({ kind: "classifier", workerId: env.WORKER_ID });
  const sql = noelleDb();
  const secrets = createSecretsClient({ project: env.GCP_PROJECT });

  // Noelle-billed scoring backend, chosen by NOELLE_CLASSIFIER_BACKEND:
  //   - "vertex" (default, managed prod): Vertex AI Gemini via the worker's ADC.
  //   - "bedrock" (self-host Lima VM): Bedrock Claude via the worker's AWS keys
  //     (Vertex user-ADC dies with invalid_rapt on the residential box).
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
    noelleBackend = createVertexBackend({ project: env.GCP_PROJECT });
    log.info({}, "classifier backend: vertex (gemini)");
  }
  const budgetAdapters = createPgBudgetAdapters(sql, { exemptEngines: CAP_EXEMPT_ENGINES_APIFY });
  const spendRecorder = createPgSpendRecorder(sql);

  const boot = await runBootChecks({
    log,
    checks: [
      { name: "db.ping", kind: "transient", run: async () => { await sql`select 1 as ok`; } },
    ],
  });
  if (!boot.ok) process.exit(boot.exitCode);

  const notifier = createNotifier({ secrets, log });
  log.info({}, "reddit classifier worker ready");
  const shouldStop = installShutdown(log);

  await runWorkerLoop({
    log,
    kind: "classifier",
    pollMs: env.CLASSIFIER_POLL_MS,
    idlePollMs: env.IDLE_POLL_MS,
    listActive: () => listActiveRedditInternInstances(sql),
    onTick: async (inst) => {
      const meteredBackend = createBudgetedBackend(noelleBackend, {
        engine: recordEngine,
        context: { orgId: inst.org_id, instanceId: inst.id, agentRole: "reddit_intern", worker: "classifier", bucket: "classifier" },
        budget: { adapters: budgetAdapters }, recorder: spendRecorder,
      });
      // Pausing the instance puts Orion fully to sleep (its only lane is the
      // subreddit watchlist, not priority people — see discovery.ts), so the loop
      // only ever sees ACTIVE instances. The per-worker classifier flag still gates
      // it; the goal-driven pipeline runs below.
      if (!isWorkerEnabled(inst, "classifier")) {
        log.debug({ instance: inst.id }, "classifier: disabled for instance; skipping");
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
        // Goal auto-stop: pause the pipeline once a goal-run produced its N
        // approvals. Cheap index-only count before any LLM call.
        const goal = await enforceGoal(sql, inst, { stallMs: env.REDDIT_GOAL_STALL_MIN * 60_000 });
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

        // Backpressure gate: classifier output ultimately feeds the drafter,
        // which feeds the approval inbox. If approvals are already at the
        // (effective) cap, classifying more leads just deepens the future
        // pile-up. Skip before doing any classification work.
        const cap = effectiveDraftsCap(inst);
        if (cap != null) {
          const pending = await countPendingApprovalsForInstance(sql, inst.id);
          if (pending >= cap) {
            log.info(
              { org_id: inst.org_id, pending, cap },
              "classifier paused: pending approvals at cap",
            );
            await run.finish({ status: "ok", rowsProcessed: 0 });
            return;
          }
        }

        // Billing path. If the org brought its own Gemini key, classify through
        // Google AI Studio with that key so usage bills *their* account.
        // Otherwise use the Noelle-billed backend. NOT_FOUND is the common case
        // (Noelle-billed) and is expected, not an error.
        let backend: EngineBackend = meteredBackend;
        let byo = false;
        try {
          const byoKey = await secrets.getForOrg(inst.org_id, "gemini-api-key");
          backend = createGeminiKeyBackend({ apiKey: byoKey });
          byo = true;
        } catch (err) {
          if (!(err instanceof SecretAccessError) || !/NOT_FOUND/.test(err.message)) throw err;
        }

        // Budget gate + spend recording apply ONLY to the Noelle-billed path.
        // A BYO-key org pays Google directly. Skip the tick when the
        // org/instance is at its cap on the `classifier` bucket.
        // claude-cli (flat-rate, cents=0) is exempt inside the gate.
        if (!byo) {
          const blocked = await classifierBudgetBlock(budgetAdapters, {
            orgId: inst.org_id,
            instanceId: inst.id,
            engine: recordEngine,
          });
          if (blocked) {
            log.info(
              {
                org_id: inst.org_id,
                layer: blocked.layer,
                spent_cents: blocked.spentCents,
                cap_cents: blocked.capCents,
              },
              "classifier paused: budget cap reached",
            );
            await run.finish({ status: "ok", rowsProcessed: 0 });
            return;
          }
        }

        // Resolve the model for the active backend:
        //   - Bedrock (self-host): fixed Claude handle.
        //   - Gemini (BYO key, or Vertex default): honour the per-worker override;
        //     non-Gemini picks fall back to Gemini Flash + log.
        let classifierModel: string | undefined;
        if (!byo && billedEngine === "bedrock") {
