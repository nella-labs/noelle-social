import { loadEnv } from "../env.js";
import { getVoiceExemplars } from "@noelle/runtime/prior-replies";
import { createLogger } from "../lib/logger.js";
import { noelleDb } from "../lib/db.js";
import { listActiveRedditInternInstances, isWorkerEnabled } from "../lib/activation.js";
import { effectiveDraftsCap, enforceGoal } from "../lib/goal.js";
import { recordRun } from "../lib/worker-runs.js";
import { busForInstance } from "../lib/bus.js";
import { runBootChecks, EX_TEMPFAIL } from "../lib/boot.js";
import { createSecretsClient, SecretAccessError } from "../lib/secrets.js";
import { createReadyCache } from "@noelle/runtime/ready-cache";
import {
  claimLeadsForDrafting,
  countDraftedTodayByKind,
  countPendingApprovalsForInstance,
  markLeadStatus,
  type LeadRow,
  reapStaleClaims,
} from "../lib/leads-db.js";
import { fetchRedditPostComments } from "@noelle/reddit-apify";
import type { SiblingComment } from "@noelle/runtime/comment-digest";
import { createCodexRunner } from "../lib/codex-runner.js";
import { createOutboundClient } from "@noelle/runtime/outbound-client";
import { getRecentRepliesToAuthor, getRecentReplyPhrasings } from "../lib/prior-replies-db.js";
import { runWorkerLoop, installShutdown } from "./_runtime.js";
import { runDrafterTick } from "./drafter-tick.js";
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
} from "@noelle/runtime";
import type { KnowledgeBase, CaptionFn, VerifierCall } from "@noelle/runtime";
import { judgeRouting } from "../lib/routing.js";
import { createPgSpendRecorder } from "@noelle/runtime/pg-spend-recorder";
import { createPgBudgetAdapters, CAP_EXEMPT_ENGINES_APIFY } from "@noelle/runtime/pg-budget-adapters";

// How many approved POST -> REPLY pairs to show the drafter. 0 disables the
// block and restores the previous prompt exactly.
const VOICE_EXEMPLAR_COUNT = Number(process.env.NOELLE_VOICE_EXEMPLARS ?? 6);

async function main() {
  const env = loadEnv();
  const log = createLogger({ kind: "drafter", workerId: env.WORKER_ID });
  const sql = noelleDb();
  const secrets = createSecretsClient({ project: env.GCP_PROJECT });
  const readyCache = createReadyCache();

  const boot = await runBootChecks({
    log,
    checks: [
      { name: "db.ping", kind: "transient", run: async () => { await sql`select 1 as ok`; } },
    ],
  });
  if (!boot.ok) process.exit(boot.exitCode);

  // Assemble the engine registry from whatever provider credentials this box has
  // (Bedrock / Anthropic-direct / OpenAI-direct / Vertex). Empty registry → a
  // lead fails loudly with EngineNotImplementedError on the first tick.
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
    budget,
    recorder,
  });
  const outbound = createOutboundClient({ baseUrl: env.CP_BASE_URL, hmacSecret: env.NOELLE_HMAC_SECRET });

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
    // Scope retrieval to the curated voice base when configured, so Orion grounds
    // on the operator's voice — not docs that happen to share keywords with the
    // post. Unset → whole-vault (back-compat).
    const voiceDirs = parseIncludeDirs(env.NOELLE_VOICE_DIRS);
    const knowledgeDirs = parseIncludeDirs(env.NOELLE_KNOWLEDGE_DIRS);
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

  log.info({}, "reddit drafter worker ready");
  const shouldStop = installShutdown(log);

  await runWorkerLoop({
    log,
    kind: "drafter",
    pollMs: env.DRAFTER_POLL_MS,
    idlePollMs: env.IDLE_POLL_MS,
    listActive: () => listActiveRedditInternInstances(sql),
    onTick: async (inst) => {
      const postOutbound = (body: Parameters<typeof outbound.postOutbound>[0]) =>
        outbound.postOutbound(body, { orgId: inst.org_id, agentInstanceId: inst.id });
      // Pausing the instance puts Orion fully to sleep. Its only lane is the
      // subreddit watchlist (not priority people, unlike Vega/Lyra — see
      // discovery.ts), so the loop only ever sees ACTIVE instances; a paused Orion
      // never reaches here and stops drafting entirely.
      if (!isWorkerEnabled(inst, "drafter")) {
        log.debug({ instance: inst.id }, "drafter disabled for instance; skipping");
        return;
      }
      const bus = busForInstance(inst);
      const run = await recordRun({ sql, kind: "drafter", bus });
      try {
        // Admit a complete current rule set before any writer work or new claims.
        const patternRules = await loadActivePatternRules(sql, {
          orgId: inst.org_id,
          agentInstanceId: inst.id,
          role: "reddit_intern",
        });
        // Recover leads stranded at 'drafting' by a crash/restart mid-claim —
        // without this they are invisible to every future claim (see reapStaleClaims).
        const reaped = await reapStaleClaims(sql, {
          agentInstanceId: inst.id,
          claimedStatus: "drafting",
          requeueStatus: "classified",
        });
        if (reaped.requeued || reaped.expired) {
          log.warn({ org_id: inst.org_id, ...reaped }, "reaped stale drafting claims");
        }
        // Goal auto-stop: once a goal-run has produced its N approvals, pause the
        // instance and stop. Checked before any work/spend.
        const goal = await enforceGoal(sql, inst, { stallMs: env.REDDIT_GOAL_STALL_MIN * 60_000 });
        if (goal?.paused) {
          log.info(
            { org_id: inst.org_id, produced: goal.produced, target: goal.target, stalled: goal.stalled },
            goal.stalled ? "goal stalled — pipeline paused" : "goal reached — pipeline paused",
          );
          await run.finish({ status: "ok", rowsProcessed: 0 });
          return;
        }

        // Backpressure gate: when the operator's approval inbox is at the
        // (effective) cap, generating more drafts just buries them.
        const cap = effectiveDraftsCap(inst);
        if (cap != null) {
          const pending = await countPendingApprovalsForInstance(sql, inst.id);
          if (pending >= cap) {
            log.info({ org_id: inst.org_id, pending, cap }, "drafter paused: pending approvals at cap");
            await run.finish({ status: "ok", rowsProcessed: 0 });
            return;
          }
        }

        // Resolve the knowledge base for this tick. local/gcs are shared from
        // boot; the legacy http backend needs a per-org key, fetched here.
        let kb: KnowledgeBase;
        if (sharedKb) {
          kb = sharedKb;
        } else {
          let nellaKey = "";
          await readyCache.ensure(inst.org_id, "drafter", async () => {
            nellaKey = await secrets.getForOrg(inst.org_id, "nella-api-key");
          });
          if (!nellaKey) nellaKey = await secrets.getForOrg(inst.org_id, "nella-api-key");
          kb = knowledgeBaseFromNella(createNellaClient({ apiKey: nellaKey, baseUrl: env.NELLA_BASE_URL }), kbWorkspace);
        }

        // Vision caption: when a lead carries post images, caption them so the
        // text-only drafter can react to the visual. BYO Gemini key first; on the
        // self-host Lima VM fall back to Vertex ADC. Transport failures return
        // empty context; budget denial stops drafting for this tick.
        let captionFn: CaptionFn | undefined;
        const metering = { context: { orgId: inst.org_id, instanceId: inst.id, agentRole: "reddit_intern" as const,
          worker: "drafter", bucket: "vision_caption" }, budget, recorder };
        try {
          const geminiKey = await secrets.getForOrg(inst.org_id, "gemini-api-key");
          if (geminiKey) captionFn = createGeminiCaptionFn({ apiKey: geminiKey, metering });
        } catch (err) {
          if (!(err instanceof SecretAccessError) || !/NOT_FOUND/.test(err.message)) {
            log.warn({ org_id: inst.org_id, err: (err as Error).message }, "gemini key lookup for vision failed; captions disabled");
          }
        }
        if (!captionFn && env.NOELLE_VERTEX_ENABLED) {
          captionFn = createVertexCaptionFn({
            metering,
            project: env.GCP_PROJECT,
            location: env.VERTEX_LOCATION,
          });
          log.info({ project: env.GCP_PROJECT, location: env.VERTEX_LOCATION }, "vision captions via Vertex ADC (no gemini key)");
        }

        // All Reddit leads are subreddit posts (priority=false) — claim the oldest
        // classified batch. There is no second priority lane.
        const leads = await claimLeadsForDrafting(sql, { agentInstanceId: inst.id, batch: 5 });
          // The operator's real POST -> REPLY pairs, once per tick. Noelle already
          // had this data and used it only as an avoid-list.
          const voiceExemplars = await getVoiceExemplars(sql, {
            agentInstanceId: inst.id,
            limit: VOICE_EXEMPLAR_COUNT,
          });
        const n = await runDrafterTick({
          voiceExemplars,
          log,
          instance: inst,
          claimedLeads: leads,
          patternRules,
          runner,
          kb,
          postOutbound,
          markStatus: (a) => markLeadStatus(sql, a),
          relevanceThreshold: env.DRAFTER_RELEVANCE_THRESHOLD,
          // Daily volume rules: ≤ N substantial + ≤ M light posts drafted/day.
          dailySubstantialCap: env.REDDIT_DAILY_SUBSTANTIAL_CAP,
          dailyLightCap: env.REDDIT_DAILY_LIGHT_CAP,
          // Skip (don't draft) leads whose post is older than this. 0 = OFF.
          maxPostAgeHours: env.REDDIT_MAX_POST_AGE_HOURS,
          bus,
          draftedTodayByKind: (replyKind) =>
            countDraftedTodayByKind(sql, { agentInstanceId: inst.id, replyKind }),
          sql,
          // Score-based Opus tiering: high-engagement source posts get the stronger
          // model. Engagement is reused from Apify (payload), no API call.
          opusScoreThreshold: env.REDDIT_OPUS_SCORE,
          opusCommentsThreshold: env.REDDIT_OPUS_COMMENTS,
          opusModel: env.NOELLE_DRAFTER_OPUS_MODEL,
          // ── Grounded-drafting (all default OFF until the operator sets env). ──
          voiceDirs: parseIncludeDirs(env.NOELLE_VOICE_DIRS),
          knowledgeDirs: parseIncludeDirs(env.NOELLE_KNOWLEDGE_DIRS),
          knowledgeTopK: env.NOELLE_DRAFTER_KNOWLEDGE_TOPK,
          captionFn,
          // Post-draft verifier + regenerate loop (gated on NOELLE_DRAFTER_VERIFY).
          verify: env.NOELLE_DRAFTER_VERIFY
            ? {
                enabled: true,
                retries: env.NOELLE_DRAFTER_VERIFY_RETRIES,
                voiceFloor: env.NOELLE_DRAFTER_VOICE_FLOOR,
                // Judge runs on Haiku (judgeRouting) — it scores, it doesn't write.
                makeCalls: (): VerifierCall[] => {
                  const judge: VerifierCall = (system, prompt) =>
                    runner
                      .draft({
                        bucket: "drafter-verify",
                        routing: judgeRouting(),
                        orgId: inst.org_id,
                        instanceId: inst.id,
                        worker: "drafter",
                        agentRole: "reddit_intern",
                        system,
                        prompt,
                      })
                      .then((r) => r.text);
                  return [judge];
                },
              }
            : undefined,
          // Voice variety: per-lead random register injected into the comment prompt.
          variety: { enabled: env.NOELLE_DRAFTER_VARIETY },
          // Post-energy mirroring (NOELLE_DRAFTER_ENERGY; default off → byte-identical).
          // On → energy-aware register + a "POST ENERGY" hint so a joke gets a joke,
          // a vent gets commiseration, never philosophy on a shitpost.
          energy: { enabled: env.NOELLE_DRAFTER_ENERGY },
          // Sibling-comment "read the room" fetch (NOELLE_DRAFTER_COMMENT_ENERGY; off →
          // byte-identical). Reddit reads the FREE public .json endpoint (no token, no
          // Apify spend); fetchRedditPostComments is fail-open by construction.
          ...(env.NOELLE_DRAFTER_COMMENT_ENERGY
            ? {
                fetchSiblingComments: async (lead: LeadRow): Promise<SiblingComment[]> => {
                  const comments = await fetchRedditPostComments({
                    postId: lead.external_id,
                    limit: env.NOELLE_DRAFTER_COMMENT_MAX,
                  });
                  return comments.map((c) => ({ text: c.body, author: c.author, score: c.score }));
                },
              }
            : {}),
          // Per-author memory: inject the replies already sent/queued to this
          // post's author so the comment doesn't repeat a take Orion already made.
          getPriorReplies: (a) =>
            getRecentRepliesToAuthor(sql, { ...a, agentInstanceId: inst.id }),
          priorRepliesTopK: env.REDDIT_DRAFTER_SENT_TOPK,
          // Global avoid-list: Orion's recent replies across the whole feed.
          getRecentPhrasings: (a) =>
            getRecentReplyPhrasings(sql, { ...a, agentInstanceId: inst.id }),
          recentPhrasingsTopK: env.REDDIT_DRAFTER_RECENT_PHRASINGS_TOPK,
          // SECURITY: fence the UNTRUSTED Reddit post text, image caption, and
          // top-comments digest (default ON for Reddit).
          fenceUntrusted: env.NOELLE_DRAFTER_FENCE,
          // Deterministic comment targeting: reply to the most-upvoted comment when
          // it clears the score floor (default ON).
          commentTargeting: {
            enabled: env.REDDIT_COMMENT_TARGETING,
            minScore: env.REDDIT_COMMENT_TARGET_MIN_SCORE,
          },
        });

        // ── Pattern Breaker (default OFF: REDDIT_PATTERN_BREAKER). ────────────
        // Drain the AI-refine queue every tick (cheap; no-op when empty), and
        // re-audit the operator's last-N sent replies at most once per interval.
        // Both fail-soft: any error is logged and the drafter tick still succeeds.
        if (env.REDDIT_PATTERN_BREAKER) {
          try {
            await runPatternRefineTick({
              log,
              instance: inst,
              runner,
              bus,
              loadQueue: () => loadRefiningAlerts(sql, {
                orgId: inst.org_id,
                agentInstanceId: inst.id,
                role: "reddit_intern",
              }),
              claim: (item) => claimRefinement(sql, {
                orgId: inst.org_id,
                agentInstanceId: inst.id,
                role: "reddit_intern",
              }, item),
              applyRefined: (a) => applyRefinedRule(sql, {
                orgId: inst.org_id,
                agentInstanceId: inst.id,
                role: "reddit_intern",
              }, { ...a, decidedBy: "pattern-breaker" }),
            });
            const last = lastPatternAnalysisAt.get(inst.id) ?? 0;
            if (Date.now() - last >= env.PATTERN_BREAKER_INTERVAL_MS) {
              lastPatternAnalysisAt.set(inst.id, Date.now());
              await runPatternBreakerTick({
                log,
                instance: inst,
                runner,
                bus,
                minFrequency: env.PATTERN_BREAKER_MIN_FREQUENCY,
                minRatio: env.PATTERN_BREAKER_MIN_RATIO,
                loadCorpus: () => loadRecentPosts(sql, {
                  orgId: inst.org_id,
                  agentInstanceId: inst.id,
                  role: "reddit_intern",
                }, env.PATTERN_BREAKER_MAX_POSTS),
                loadExistingLabels: () => loadActiveRuleLabels(sql, {
                  orgId: inst.org_id,
                  agentInstanceId: inst.id,
                  role: "reddit_intern",
                }),
                persist: (finding, windowSize, corpus) =>
                  persistPattern(sql, {
                    orgId: inst.org_id,
                    agentInstanceId: inst.id,
                    role: "reddit_intern",
                    finding,
                    windowSize,
                    corpus,
                  }),
              });
            }
          } catch (err) {
            log.warn({ instance: inst.id, err: (err as Error).message }, "pattern breaker pass failed (non-fatal)");
          }
        }

        await run.finish({ status: "ok", rowsProcessed: n });
      } catch (err) {
        readyCache.reset(inst.org_id, "drafter");
        await run.finish({ status: "error", errorMessage: (err as Error).message });
        throw err;
      }
    },
    shouldStop,
  });
}

// Per-instance cadence for the (heavy) Pattern Breaker analysis pass. In-memory
// is fine: it's a soft throttle, and a worker restart just re-runs the audit
// once. The cheap refine-queue drain runs every tick regardless.
const lastPatternAnalysisAt = new Map<string, number>();

main().catch((err) => {
  console.error("drafter fatal:", err);
  process.exit(EX_TEMPFAIL);
});
