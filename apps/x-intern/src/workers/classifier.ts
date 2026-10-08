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
        if (observedReaped.requeued) {
          log.warn({ org_id: inst.org_id, ...observedReaped }, "requeued stranded X observations");
        }
        // Claim one observation at a time: a Jev outage never strands a batch
        // in a mid-claim status, and the retry pause avoids a hot outage loop.
        let observedProcessed = 0;
        if (Date.now() >= (jevRetryAfter.get(inst.id) ?? 0)) {
          const strictClassifier = createClassifier({
            backend: meteredBackend,
            objective: inst.objective ?? null,
            vipScout: false,
          });
          for (let i = 0; i < 10; i++) {
            const [lead] = await claimObservedLeadsForClassification(sql, {
              orgId: inst.org_id, agentInstanceId: inst.id, batch: 1,
            });
            if (!lead) break;
            const outcome = await classifyOneLead({
              sql, classifier: strictClassifier, notifier, inst, lead, log, bus,
              observedThreshold: env.X_Q_THRESHOLD,
            });
            if (outcome === "jev_unavailable") {
              jevRetryAfter.set(inst.id, Date.now() + 60_000);
              break;
            }
            observedProcessed++;
          }
        }
        // Backpressure gate: classifier output ultimately feeds the drafter,
        // which feeds the approval inbox. If approvals are at the (effective)
        // cap, classifying more keyword leads just deepens the pile-up — so the
        // keyword lane stops. The watchlist lane ignores this cap (watched
        // accounts are always-on, with their own one-per-person bound).
        let keywordBlocked = !keywordLaneOn;
        if (keywordLaneOn) {
          const cap = effectiveDraftsCap(inst);
          if (cap != null) {
            const pending = await countPendingApprovalsForInstance(sql, inst.id);
            if (pending >= cap) {
              keywordBlocked = true;
              log.info({ org_id: inst.org_id, pending, cap }, "keyword lane paused: pending at cap");
            }
          }
        }
        if (keywordBlocked && !watchlistLaneOn) {
          await run.finish({ status: "ok", rowsProcessed: observedProcessed });
          return;
        }

        // Billing path. If the org brought its own Gemini key on the
        // /connections page (`gemini-api-key`), classify through Google AI
        // Studio with that key so usage bills *their* account. Otherwise use
        // the Noelle-billed Vertex backend (trial credit). NOT_FOUND is the
        // common case (Noelle-billed) and is expected, not an error — any
        // other secret error propagates. Successful reads are TTL-cached by
        // the secrets client, so the BYO lookup is one cached call per tick.
        let backend: EngineBackend = meteredBackend;
        let byo = false;
        try {
          const byoKey = await secrets.getForOrg(inst.org_id, "gemini-api-key");
          backend = createGeminiKeyBackend({ apiKey: byoKey });
          byo = true;
        } catch (err) {
          if (!(err instanceof SecretAccessError) || !/NOT_FOUND/.test(err.message)) throw err;
        }

        // Budget gate + spend recording apply ONLY to the Noelle-billed
        // (Vertex) path. A BYO-key org pays Google directly, so its classifier
        // usage is neither recorded as Noelle spend nor gated by the Noelle
        // cap. On the Noelle path, skip the tick when the org/instance is at
        // its cap on the `classifier` bucket; the next tick re-checks once
        // spend frees up (a new month, or the owner raises the cap).
        // Subscription and paid engines both retain the shared admission gate.
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
              "classifier paid lanes paused: budget cap reached",
            );
            await run.finish({ status: "ok", rowsProcessed: observedProcessed });
            return;
          }
        }

        // Resolve the model for the active backend:
        //   - Bedrock (Noelle-billed, self-host): fixed Claude handle. The
        //     dashboard's Gemini-only override doesn't apply here.
        //   - Gemini (BYO key, or Vertex default): honour the per-worker
        //     override; non-Gemini picks fall back to Gemini Flash + log
        //     (the override targets an engine the Gemini backend can't reach).
        let classifierModel: string | undefined;
        if (!byo && billedEngine === "bedrock") {
          classifierModel = bedrockModel ?? undefined;
        } else {
          const { model, fellBack } = resolveClassifierModel(inst.model_overrides);
          classifierModel = model ?? undefined;
          if (fellBack) {
            log.info(
              { org_id: inst.org_id },
              "classifier override targets a non-Gemini engine; falling back to default Gemini Flash until that backend lands",
            );
          }
        }
        const classifier = createClassifier({
          backend,
          ...(classifierModel ? { model: classifierModel } : {}),
          objective: inst.objective ?? null,
          // Relationship scout flags high-leverage authors + pre-drafts an intro
          // DM in the SAME classifier call. On unless NOELLE_VIP_SCOUT is
          // explicitly disabled — additive + fail-open (no field → vip=null).
          vipScout: VIP_SCOUT_ENABLED,
        });

        // When the keyword lane is live, claim any 'new' lead (covers priority
        // too). When it's blocked (paused / disabled / inbox full) but the watchlist
        // lane is on, claim only priority leads so watched accounts keep moving.
        const claimed = await claimLeadsForClassification(sql, {
          orgId: inst.org_id,
          agentInstanceId: inst.id,
          batch: CLASSIFICATION_BATCH_LIMIT,
          priorityOnly: keywordBlocked,
        });
        // CLI_CONCURRENCY bounds local process fan-out; other backends run at
        // most the ten claimed posts together. Rejected admission returns only
        // unchanged claims to the queue immediately.
        const usingCli = !byo && recordEngine === "claude-cli";
        const concurrency = usingCli ? CLI_CONCURRENCY : Math.max(1, claimed.length);

        // Prepare admission once before any batch or single-post model call.
        // Uncovered eligible posts retain the existing per-post fallback.
        const prepared = claimed.map((lead) => ({
          lead,
          eligibility: classificationEligibility(lead, inst),
        }));
        const eligible = prepared.filter(({ eligibility }) => !eligibility.drop);
        const pre = new Map<string, ClassifyOutput>();
        if (usingCli && CLASSIFIER_BATCH && eligible.length > 1) {
          let batch: BatchClassifyResult;
          try {
            batch = await classifier.classifyMany(
              eligible.map(({ lead }) => {
                const p = (lead.payload ?? {}) as {
                  text?: string;
                  author_followers?: number | null;
                };
                return {
                  postText: p.text ?? "",
                  authorHandle: lead.author_handle,
                  source: "x" as const,
                  velocityAtDiscovery: 0,
                  authorFollowers: p.author_followers ?? null,
                };
              }),
            );
          } catch (error) {
            if (isBudgetAdmissionError(error)) {
              await releaseClassificationClaims(sql, {
                orgId: inst.org_id,
                agentInstanceId: inst.id,
                claims: claimed,
              });
            }
            throw error;
          }
          batch.verdicts.forEach((verdict, index) => {
            if (verdict) pre.set(eligible[index]!.lead.id, verdict);
          });
          log.info(
            { claimed: claimed.length, eligible: eligible.length, covered: pre.size },
            "classifier: batched call",
          );
        }

        const outcomes = await batchMap(
          prepared,
          ({ lead, eligibility }) =>
