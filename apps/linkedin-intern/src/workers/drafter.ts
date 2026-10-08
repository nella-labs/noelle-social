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
      const run = await recordRun({ sql, kind: "drafter", bus });
      try {
        // Admit a complete current rule set before any writer work or new claims.
        const patternRules = await loadActivePatternRules(sql, {
          orgId: inst.org_id,
          agentInstanceId: inst.id,
          role: "linkedin_intern",
        });
        const recoveredAtStartup = await recoverStartupClaims(inst.id);
        if (recoveredAtStartup.requeued || recoveredAtStartup.reconciled || recoveredAtStartup.approvalsRepaired) {
          log.warn({ org_id: inst.org_id, ...recoveredAtStartup }, "recovered drafting claims from previous worker process");
        }
        // Recover leads stranded at 'drafting' by a crash/restart mid-claim —
        // without this they are invisible to every future claim (see reapStaleClaims).
        const reaped = await reapStaleClaims(sql, {
          agentInstanceId: inst.id,
          claimedStatus: "drafting",
          requeueStatus: "classified",
        });
        if (reaped.requeued || reaped.expired || reaped.reconciled || reaped.approvalsRepaired) {
          log.warn({ org_id: inst.org_id, ...reaped }, "reaped stale drafting claims");
        }
        const relationshipDmDrafted = await runRelationshipDmsForInstance({
          sql,
          instance: inst,
          runner,
          postOutbound,
          log,
        });
        // On-demand DM requests run first, independent of the goal/backpressure
        // gates below — the operator explicitly asked for these DMs.
        const dmRequests = await claimDmRequestLeads(sql, {
          agentInstanceId: inst.id,
          cap: 5,
        });
        const replyRequests = await claimReplyRequestLeads(sql, {
          agentInstanceId: inst.id,
          cap: 5,
        });
        let replyPipelineBlocked = false;
        let dmDrafted = 0;
        if (dmRequests.length > 0) {
          // The DM ladder grounds on the post + person + rung (not the vault KB),
          // so no Nella knowledge base is needed here. It reads sql to compute the
          // person's rung (how many DMs already sent) + avoid repeating prior DMs.
          dmDrafted = await runDmRequestTick({
            log,
            instance: inst,
            claimedLeads: dmRequests,
            runner,
            postOutbound,
            sql,
          });
        }

        if (!drafterLaneOn && !notifLaneOn && replyRequests.length === 0) {
          await run.finish({ status: "ok", rowsProcessed: relationshipDmDrafted + dmDrafted });
          return;
        }

        // Reply drafting runs while ACTIVE (full funnel) OR while the always-on
        // WATCHLIST lane is enabled — Lyra is watchlist-only, so a paused instance
        // with watchlist_enabled keeps drafting replies to watched connections
        // (e.g. after a goal stalls + auto-pauses). A paused instance with the
        // watchlist lane OFF ticks here solely for the on-demand DM requests
        // above, then stops. (The goal block below no-ops while paused — the goal
        // is always cleared on pause — and the backpressure cap still applies, so
        // the watchlist lane never buries the operator's inbox.)
        if (inst.status === "paused" && !isWorkerEnabled(inst, "watchlist") && !notificationsOnly && replyRequests.length === 0) {
          await run.finish({ status: "ok", rowsProcessed: relationshipDmDrafted + dmDrafted });
          return;
        }

        // Goal auto-stop: once a goal-run has produced its N approvals, pause the
        // instance and stop. Checked before any work/spend.
        const ordinaryReplyLaneAvailable = drafterLaneOn || notifLaneOn || isWorkerEnabled(inst, "watchlist");
        const goal = ordinaryReplyLaneAvailable
          ? await enforceGoal(sql, inst, { stallMs: env.LINKEDIN_GOAL_STALL_MIN * 60_000 })
          : null;
        if (goal?.paused) {
          log.info(
            { org_id: inst.org_id, produced: goal.produced, target: goal.target, stalled: goal.stalled },
            goal.stalled
              ? "goal stalled (watchlist exhausted, no new leads) — pipeline paused"
              : "goal reached — pipeline paused",
          );
          if (replyRequests.length === 0) {
            await run.finish({ status: "ok", rowsProcessed: relationshipDmDrafted + dmDrafted });
            return;
          }
          replyPipelineBlocked = true;
        }

        // Backpressure gate: when the operator's approval inbox is at the
        // (effective) cap, generating more drafts just buries them.
        const cap = effectiveDraftsCap(inst);
        if (ordinaryReplyLaneAvailable && cap != null) {
          const pending = await countPendingApprovalsForInstance(sql, inst.id);
          if (pending >= cap) {
            log.info(
              { org_id: inst.org_id, pending, cap },
              "drafter paused: pending approvals at cap",
            );
            if (replyRequests.length === 0) {
              await run.finish({ status: "ok", rowsProcessed: relationshipDmDrafted });
              return;
            }
            replyPipelineBlocked = true;
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

        // Resolve the org's active Apify token for comment-energy (hot-swap), and
        // capture the credential id so the comment-fetch spend is attributed to it.
        let fetchPostComments: ((postUrl: string) => Promise<LinkedInComment[]>) | undefined;
        if (resolveApify) {
          try {
            const apify = await resolveApify(inst.org_id);
            if (apify) {
              fetchPostComments = postUrl => withMeteredApifyCall({ client: apify.client, recorder, log,
                orgId: inst.org_id, instanceId: inst.id, agentRole: "linkedin_intern", worker: "drafter",
                actor: "linkedin-post-comments", startedAt: new Date(), credentialId: apify.credentialId },
                operation => operation.postComments({ postUrl, maxComments: env.LINKEDIN_DRAFTER_COMMENT_MAX }));
            }
          } catch {
            log.warn(
              { org_id: inst.org_id },
              "apify credential lookup failed; drafting without comment context",
            );
          }
        }

        // Vision caption (B2b): when a lead carries post images, caption them so
        // the text-only drafter can react to the visual. We build the captionFn
        // from the org's BYO Gemini key (the same key family the classifier uses);
        // NOT_FOUND is the common case and just disables vision (captionImages
        // returns empty context on transport failure). Secret errors disable
        // captions; budget denial defers drafting for this tick.
        let captionFn: CaptionFn | undefined;
        const metering = { context: { orgId: inst.org_id, instanceId: inst.id, agentRole: "linkedin_intern" as const,
          worker: "drafter", bucket: "vision_caption" }, budget, recorder };
        try {
          const geminiKey = await secrets.getForOrg(inst.org_id, "gemini-api-key");
          if (geminiKey) captionFn = createGeminiCaptionFn({ apiKey: geminiKey, metering });
        } catch (err) {
          if (!(err instanceof SecretAccessError) || !/NOT_FOUND/.test(err.message)) {
            log.warn({ org_id: inst.org_id, err: (err as Error).message }, "gemini key lookup for vision failed; captions disabled");
          }
        }
        // No org BYO key: use the worker's global Gemini key (generativelanguage
        // API — no ADC, no reauth). Preferred over Vertex ADC on the self-host box
        // (ADC is flaky there) and keeps vision on a cheap Google path, never paid
        // Bedrock. Transport failures return empty context; budget denial defers.
        if (!captionFn && env.NOELLE_GEMINI_API_KEY) {
          captionFn = createGeminiCaptionFn({ apiKey: env.NOELLE_GEMINI_API_KEY, metering });
          log.info({ org_id: inst.org_id }, "vision captions via global Gemini key (no org key)");
        }
        // Self-host fallback: no Gemini key at all, but Vertex is enabled and the
        // worker has a service account (GOOGLE_APPLICATION_CREDENTIALS). Caption
        // via Vertex Gemini with ADC. Auth/transport failures return empty context;
        // budget denial defers drafting.
        if (!captionFn && env.NOELLE_VERTEX_ENABLED) {
          captionFn = createVertexCaptionFn({
            metering,
            project: env.GCP_PROJECT,
            location: env.VERTEX_LOCATION,
          });
          log.info({ project: env.GCP_PROJECT, location: env.VERTEX_LOCATION }, "vision captions via Vertex ADC (no gemini key)");
        }
        // Last-resort fallback: a vision-capable Claude on AWS Bedrock (PAID; the
        // CLI subscription can't caption images). Default OFF now
        // (NOELLE_VISION_BEDROCK) so image posts never silently bill AWS; set
        // NOELLE_VISION_BEDROCK=1 to opt back in. Transport failures return empty
        // context; budget denial defers drafting.
        if (!captionFn && env.NOELLE_VISION_BEDROCK) {
          captionFn = createBedrockCaptionFn({ metering });
          log.info({ org_id: inst.org_id }, "vision captions via Bedrock Claude (opt-in)");
        }



        // The full drafter arg set, built once and reused by both paths
        // (notifications-only and the normal two-lane claim) so they can never
        // drift apart in their grounding, caps, verifier or style config.
        // Return type pinned to runDrafterTick's parameter. Extracting the arg
        // set out of the call expression lost CONTEXTUAL typing, so every
        // callback in it (markStatus, pinNotification, getPriorReplies…) went
        // implicit-any and the build failed even though `tsc --noEmit` — which
        // runs a looser config here — was happy.
          // The operator's real POST -> REPLY pairs, once per tick. Noelle already
          // had this data and used it only as an avoid-list.
          const voiceExemplars = await getVoiceExemplars(sql, {
            agentInstanceId: inst.id,
            limit: VOICE_EXEMPLAR_COUNT,
            humanOnly: true,
          });
        const drafterArgs = (
          claimedLeads: LeadRow[],
          forceVerify = false,
        ): Parameters<typeof runDrafterTick>[0] => ({
          voiceExemplars,
          log,
          instance: inst,
          claimedLeads,
          patternRules,
          runner,
          kb,
          postOutbound,
          markStatus: (a) => markLeadStatus(sql, a),
          // Pushover the operator for a notification too important to answer
          // with an agent. Fail-soft: no Pushover channel ⇒ no_channel, no throw.
          pinNotification: async ({ title, message, url }) => {
            // Report DELIVERY, not just "we tried": the tick keeps the lead
            // visible (status 'errored') when a pin does not actually land,
            // so a real opportunity can never vanish into the skip pile.
            const r = await notifier.notify({
              orgId: inst.org_id,
              title,
              message,
              ...(url ? { url, url_title: "open the thread" } : {}),
            });
            return r.status === "sent";
          },
          relevanceThreshold: env.DRAFTER_RELEVANCE_THRESHOLD,
          // Daily volume rules: ≤ N substantial + ≤ M light posts drafted/day.
          // When a kind's cap is hit, leads of that kind stay 'classified' for a
          // later day (never downgraded). 0 = unlimited (the default); the tick
          // normalizes that, so it is never a "draft nothing" instruction.
          dailySubstantialCap: env.LINKEDIN_DAILY_SUBSTANTIAL_CAP,
          dailyLightCap: env.LINKEDIN_DAILY_LIGHT_CAP,
          bus,
          draftedTodayByKind: (replyKind) =>
            countDraftedTodayByKind(sql, { agentInstanceId: inst.id, replyKind }),
          sql,
          // Reaction-based Opus tiering: high-engagement source posts get the
          // stronger model. Engagement is reused from Apify (payload), no API call.
          opusLikesThreshold: env.LINKEDIN_OPUS_LIKES,
          opusCommentsThreshold: env.LINKEDIN_OPUS_COMMENTS,
          opusModel: env.NOELLE_DRAFTER_OPUS_MODEL,
          // Comment-energy: read the room before drafting. Apify spend for the
          // fetch is recorded (engine='apify') via the shared recorder, attributed
          // to each attempted token.
          fetchPostComments,
          commentFetchMax: env.LINKEDIN_DRAFTER_COMMENT_MAX,
          // ── Grounded drafting extras (default off until configured). ──
          // Scope voice retrieval + run a second knowledge pass when configured.
          voiceDirs: parseIncludeDirs(env.NOELLE_VOICE_DIRS),
          knowledgeDirs: parseIncludeDirs(env.NOELLE_KNOWLEDGE_DIRS),
          knowledgeTopK: env.NOELLE_DRAFTER_KNOWLEDGE_TOPK,
          rerankGrounding: env.NOELLE_DRAFTER_GROUNDING_RERANK,
          // Vision caption for posts with images (no-op when no key resolved).
          captionFn,
          // Reply verifier + regenerate loop (default on, explicit false allowed).
          // Unattended auto-send (LINKEDIN_UNATTENDED_AUTOSEND) FORCES verify ON and
          // lifts the floor to >=0.7 so the api-vm actuator gate has non-zero yield;
          // it can only RAISE the bar, never lower it.
          verify: (forceVerify || env.NOELLE_DRAFTER_VERIFY || env.LINKEDIN_UNATTENDED_AUTOSEND)
            ? {
                enabled: true,
                retries: env.NOELLE_DRAFTER_VERIFY_RETRIES,
                // Drop a draft whose best attempt still reads generic (voice
                // below this) instead of serving slop. 0 disables the gate.
                voiceFloor: env.LINKEDIN_UNATTENDED_AUTOSEND
                  ? Math.max(env.NOELLE_DRAFTER_VOICE_FLOOR, 0.7)
                  : env.NOELLE_DRAFTER_VOICE_FLOOR,
                // Judge runs on Haiku (judgeRouting) — it scores, it doesn't
                // write, so it never needs the drafting model. A single judge per
                // draft: the 3-adversarial majority-vote panel for watchlist leads
                // was tripling judge spend (all on Opus) for no measurable lift.
                makeCalls: (_priority, options): VerifierCall[] => {
                  const judge: VerifierCall = (system, prompt) =>
                    runner
                      .draft({
                        bucket: "drafter-verify",
                        routing: judgeRouting(),
                        orgId: inst.org_id,
                        instanceId: inst.id,
                        worker: "drafter",
                        agentRole: "linkedin_intern",
                        system,
                        prompt,
                        ...(options?.directRouting ? { directRouting: true } : {}),
                      })
                      .then((r) => r.text);
                  return [judge];
                },
              }
            : undefined,
          // Voice variety: per-lead random register injected into the comment
          // prompt (gated on NOELLE_DRAFTER_VARIETY; default off → unchanged).
          // Faithful-pin handling now lives IN THE TICK, per lead: a pinned lead
          // whose style block loaded gets a FORM VARIANT (one of 10 shapes,
          // never the previous reply's — see @noelle/runtime formVariants.ts)
          // rendered inside the faithful STYLE block, and the random register /
          // opening-move blocks are suppressed for that lead so a SLANG/HYPE
          // register never fights the pinned voice. Only when the pin fails to
          // reach the prompt (empty corpus, selection error) does the plain
          // register variety fire as the fallback.
          variety: { enabled: env.NOELLE_DRAFTER_VARIETY },
          // Per-person memory: inject the replies already sent/queued to this
          // post's author so the comment doesn't repeat a take Lyra already made.
          getPriorReplies: (a) =>
            getRecentRepliesToAuthor(sql, { ...a, agentInstanceId: inst.id }),
          priorRepliesTopK: env.LINKEDIN_DRAFTER_SENT_TOPK,
          // Global avoid-list: Lyra's recent replies across the whole feed, so
          // openers/phrasings vary feed-wide (not just per person).
          getRecentPhrasings: (a) =>
            getRecentReplyPhrasings(sql, { ...a, agentInstanceId: inst.id }),
          recentPhrasingsTopK: env.LINKEDIN_DRAFTER_RECENT_PHRASINGS_TOPK,
          // Account Feeder STYLE injection (NOELLE_DRAFTER_STYLE; default OFF).
          // Loaders fetch the style pool + ultra profiles ONCE per tick (reused
          // across leads); the tick samples per-lead. Fail-open: off or any
          // load/select error → no STYLE block, drafts exactly as today.
          //
          // WHICH KINDS: each source is stored as original posts (kind='post')
          // and authored comments (kind='comment'). readStyleExemplarKinds reads
          // account_feeder_config.styleExemplarKinds and defaults to POSTS ONLY —
          // a person's original posts are their considered voice; their comments
          // are often sloppy. We load every requested kind and concatenate into
          // one pool that selectStyleExemplars then ranks by fit + engagement.
          // (Set styleExemplarKinds to ['post','comment'] to fold comments back
          // in — the older "pool both" behaviour.)
          //
          // FAITHFUL VOICE ("write like <named person(s)>"): when the operator
          // pins one or more source accounts (account_feeder_config.faithfulVoices,
          // or the single-voice pinnedStyleHandle), ground the reply STYLE block in
          // ONLY those accounts' corpora + ultra profiles (enabled-independent),
          // force style ON even if NOELLE_DRAFTER_STYLE is off, and bump the exemplar
          // count so the named voice actually transfers. With MORE than one voice,
          // the tick picks ONE deterministically per lead (rotating across the feed)
          // so each reply faithfully sounds like a single real writer. No pin → the
          // existing automatic blend over the enabled pool.
          style: (() => {
            const styleKinds = readStyleExemplarKinds(inst.account_feeder_config);
            const faithfulVoices = readFaithfulVoices(inst.account_feeder_config);
            const faithfulVoiceWeights = readFaithfulVoiceWeights(inst.account_feeder_config);
            if (faithfulVoices.length >= 1) {
              return {
                enabled: true,
                // Faithful voice: the operator hand-picked this/these writer(s), so
                // the drafter should genuinely SOUND like them (adopt-the-voice
                // STYLE block + no register cheer-penalty in exemplar selection).
                faithful: true,
                // Pass the list through so the tick can rotate ONE voice per lead.
                faithfulVoices,
                // Optional per-voice bias for that rotation (e.g. 60/40); undefined
                // ⇒ uniform. Only meaningful with 2+ voices.
                faithfulVoiceWeights,
                loadPool: async () => {
                  const pools = await Promise.all(
                    faithfulVoices.flatMap((handle) =>
                      styleKinds.map((kind) =>
                        listStyleExemplarsForHandle(sql, {
                          agentInstanceId: inst.id,
                          platform: "linkedin",
                          kind,
                          handle,
                          limit: env.NOELLE_DRAFTER_STYLE_POOL,
                        }),
                      ),
                    ),
                  );
                  return pools.flat();
                },
                loadUltraProfiles: async () => {
                  const profiles = await Promise.all(
                    faithfulVoices.map((handle) =>
                      getUltraProfileForHandle(sql, {
                        agentInstanceId: inst.id,
                        platform: "linkedin",
                        handle,
                      }),
                    ),
                  );
                  return profiles.filter((p): p is NonNullable<typeof p> => p != null);
                },
                config: pinnedSelectConfig(inst.account_feeder_config),
                dense: env.NOELLE_DRAFTER_DENSE,
              };
            }
            return {
              enabled: env.NOELLE_DRAFTER_STYLE,
              loadPool: async () => {
                const pools = await Promise.all(
                  styleKinds.map((kind) =>
                    listStyleExemplars(sql, {
                      agentInstanceId: inst.id,
                      platform: "linkedin",
                      kind,
                      limit: env.NOELLE_DRAFTER_STYLE_POOL,
                      minPerformancePercentile: feederConfigPercentile(inst.account_feeder_config),
                    }),
                  ),
                );
                return pools.flat();
              },
              loadUltraProfiles: () =>
                listUltraProfiles(sql, { agentInstanceId: inst.id, platform: "linkedin" }),
              config: inst.account_feeder_config,
              dense: env.NOELLE_DRAFTER_DENSE,
            };
          })(),
          // F6b — tiered multi-lead batching (NOELLE_DRAFTER_BATCH; default OFF).
          // When ON, non-Opus light leads are grouped into one model call per tick,
          // each with its own post text + STYLE block. Falls back to per-lead calls
          // on any parse failure. Gated by env flag AND per-instance batchLightLeads
          // (AccountFeederConfig, default true) — set the instance config field to
          // false to disable per-instance. When env flag is OFF, byte-identical to
          // today regardless of the instance setting.
          batch: {
            enabled: env.NOELLE_DRAFTER_BATCH,
            batchLightLeads: feederConfigBatchLight(inst.account_feeder_config),
          },
        });

        const nRequested = replyRequests.length === 0
          ? 0
          : await runDrafterTick(drafterArgs(replyRequests, true));
        if (replyPipelineBlocked || (!drafterLaneOn && !notifLaneOn) ||
          (inst.status === "paused" && !isWorkerEnabled(inst, "watchlist") && !notificationsOnly)) {
          await run.finish({ status: "ok", rowsProcessed: relationshipDmDrafted + dmDrafted + nRequested });
          return;
        }

        // NOTIFICATIONS-ONLY tick. Answering someone who replied to you is not
        // the same job as cold outbound, and the operator must be able to run one
        // without the other. Before this, the only switch was the instance's
        // status, so "answer my replies" also restarted discovery, classification
        // and cold drafting.
        //
        // While PAUSED with the notifications lane on, claim ONLY notification
        // leads. Note this cannot be done with the watchlist claim: a
        // notification lead is priority=TRUE and so is essentially every
        // LinkedIn lead, so that claim would drag the whole cold funnel back in.
        if (notificationsOnly) {
          const notifLeads = await claimNotificationLeadsForDrafting(sql, {
            agentInstanceId: inst.id,
            cap: 5,
          });
          const nNotif =
            notifLeads.length === 0
              ? 0
              : await runDrafterTick(drafterArgs(notifLeads));
          await run.finish({ status: "ok", rowsProcessed: relationshipDmDrafted + dmDrafted + nRequested + nNotif });
          return;
        }

        // Two-lane drafting (0035): the keyword/funnel claim takes priority=FALSE
        // leads; profile-first (Feeder A) + ICP-vetted authors are priority=TRUE
        // and are claimed by the watchlist RPC (one newest per author). Claim both
        // and draft them together — without the second claim, priority leads would
        // sit at 'classified' forever (Lyra's main claim excludes them).
        const observedLeads = await claimObservedLeadsForDrafting(sql, { agentInstanceId: inst.id, cap: 5 });
        const keywordLeads = await claimLeadsForDrafting(sql, { agentInstanceId: inst.id, batch: 3 });
        const priorityLeads = await claimWatchlistLeadsForDrafting(sql, {
          agentInstanceId: inst.id,
          cap: 5,
        });
        let n = nRequested;
        for (const lane of planDraftLanes({
          observed: observedLeads,
          priority: priorityLeads,
          keyword: keywordLeads,
        })) {
          n += await runDrafterTick(drafterArgs(lane.leads, lane.forceVerify));
        }

        // Intro DM lane (default OFF): one warm, one-time relationship-building DM
        // per watchlist person, queued for approval. Gated on the per-instance
        // toggle (0039 `linkedin_intro_dm_enabled`, set from the agent's Config
        // page) AND the instance being ACTIVE (a paused instance still drafts
        // watchlist replies above via watchlist_enabled, but the intro-DM backfill
        // only runs when the operator has actually started the agent).
        // claimIntroDmPeople claims + stamps under SKIP LOCKED, so each person gets
        // exactly one DM, ever; the daily cap paces the rollout. Draft-only —
        // runIntroDmTick never auto-sends.
        //
        // CRITICAL: never run during a goal-run. "Get N replies ready" is a
        // reply-only objective; intro DMs are post-less leads that would otherwise
        // bury the reply queue AND (pre-fix) count toward the target, auto-pausing
        // the run before N real replies exist. Intro DMs trickle only on normal
        // (non-goal) ticks.
        const inGoalRun = goalTarget(inst) != null;
        // The per-instance toggle is authoritative; the env var is only a fallback
        // for a worker that booted before the 0039 column existed.
        const introDmEnabled = inst.linkedin_intro_dm_enabled ?? env.LINKEDIN_INTRO_DM_ENABLED;
        let introDmDrafted = 0;
        if (introDmEnabled && inst.status !== "paused" && !inGoalRun) {
          const introPeople = await claimIntroDmPeople(sql, {
            agentInstanceId: inst.id,
            cap: env.LINKEDIN_INTRO_DM_DAILY_CAP,
          });
          if (introPeople.length > 0) {
            introDmDrafted = await runIntroDmTick({
              log,
              instance: inst,
              claimedPeople: introPeople,
              runner,
              postOutbound,
            });
          }
        }

        // ── Pattern Breaker (default OFF: LINKEDIN_PATTERN_BREAKER). ──────────
        // Drain the AI-refine queue every tick (cheap; no-op when empty), and
        // re-audit the operator's last-N posts at most once per interval. Both
        // fail-soft: any error is logged and the drafter tick still succeeds.
        if (env.LINKEDIN_PATTERN_BREAKER) {
          try {
            await runPatternRefineTick({
              log,
              instance: inst,
              runner,
              bus,
              loadQueue: () => loadRefiningAlerts(sql, {
                orgId: inst.org_id,
                agentInstanceId: inst.id,
                role: "linkedin_intern",
              }),
              claim: (item) => claimRefinement(sql, {
                orgId: inst.org_id,
                agentInstanceId: inst.id,
                role: "linkedin_intern",
              }, item),
              applyRefined: (a) => applyRefinedRule(sql, {
                orgId: inst.org_id,
                agentInstanceId: inst.id,
                role: "linkedin_intern",
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
                  role: "linkedin_intern",
                }, env.PATTERN_BREAKER_MAX_POSTS),
                loadExistingLabels: () => loadActiveRuleLabels(sql, {
                  orgId: inst.org_id,
                  agentInstanceId: inst.id,
                  role: "linkedin_intern",
                }),
                persist: (finding, windowSize, corpus) =>
                  persistPattern(sql, {
                    orgId: inst.org_id,
                    agentInstanceId: inst.id,
                    role: "linkedin_intern",
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

        await run.finish({ status: "ok", rowsProcessed: relationshipDmDrafted + dmDrafted + n + introDmDrafted });
      } catch (err) {
        readyCache.reset(inst.org_id, "drafter");
        await run.finish({ status: "error", errorMessage: (err as Error).message });
        throw err;
      }
    },
    shouldStop,
    sleep: wake.sleep,
  });
}

// Per-instance cadence for the (heavy) Pattern Breaker analysis pass. In-memory
// is fine: it's a soft throttle, and a worker restart just re-runs the audit
// once. The cheap refine-queue drain runs every tick regardless.
const lastPatternAnalysisAt = new Map<string, number>();

/**
 * Extract the Account Feeder `minPerformancePercentile` floor from an instance's
 * account_feeder_config so the style-pool query can apply it server-side.
 * Defensive: a missing/malformed config falls back to the schema default (0 = no
 * floor) and never throws. The full config (incl. maxStyleExemplars /
 * varietyTemperature) is also handed to the selector for the per-lead sampling.
 */
function feederConfigPercentile(config: unknown): number {
  const parsed = AccountFeederConfigSchema.safeParse(
    config && typeof config === "object" ? config : {},
  );
  return parsed.success
    ? parsed.data.minPerformancePercentile
    : AccountFeederConfigSchema.parse({}).minPerformancePercentile;
}

/**
 * Extract the Account Feeder `batchLightLeads` flag from an instance's
 * account_feeder_config. Defensive: a missing/malformed config falls back to
 * the schema default (true). Only effective when NOELLE_DRAFTER_BATCH is also
 * ON — set to false per-instance to opt out of batching even when the env flag
 * is enabled.
 */
function feederConfigBatchLight(config: unknown): boolean {
  const parsed = AccountFeederConfigSchema.safeParse(
    config && typeof config === "object" ? config : {},
  );
  return parsed.success
    ? parsed.data.batchLightLeads
    : AccountFeederConfigSchema.parse({}).batchLightLeads;
}

main().catch((err) => {
  console.error("drafter fatal:", err);
  process.exit(EX_TEMPFAIL);
});
