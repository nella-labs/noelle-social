import type { Sql } from "postgres";
import { assertWithinCap, BudgetExceededError, type Bus, type CapAdapters } from "@noelle/runtime";
import type { Logger } from "../lib/logger.js";
import type { LeadRow } from "../lib/leads-db.js";
import type { Classifier } from "../lib/classifier-engine.js";
import { hasCanonicalObservedIdentity, markLeadClassified, markLeadStatus } from "../lib/leads-db.js";
import { detectLanguage } from "../lib/language.js";
import { draftVipIntroDm } from "../lib/vip-dm.js";
import type { CodexRunner } from "../lib/codex-runner.js";

/**
 * Off-topic floor for the priority clamp (q on the 0-100 scale). A hand-picked
 * watchlist connection's post that the engine scored a 'skip' is only rescued to
 * a 'light' note when it clears this floor — so a genuine but lightly-scored
 * milestone (e.g. q≈35 'Turning 50 today …') still gets a warm reply, while an
 * off-topic or hiring repost (q≈5-15) is left as a skip. Observed scoring: real
 * founder-lane posts land 70-90, off-lane/hiring noise lands 5-20. Override with
 * NOELLE_LI_CLAMP_MIN_Q. See docs/linkedin-intern.md.
 */
// Number("abc") is NaN and every `q >= NaN` is false, which would silently turn
// the clamp OFF rather than failing loudly. Fall back to the default.
const RAW_CLAMP_MIN_Q = Number(process.env.NOELLE_LI_CLAMP_MIN_Q ?? 25);
const CLAMP_MIN_Q = Number.isFinite(RAW_CLAMP_MIN_Q) ? RAW_CLAMP_MIN_Q : 25;

/** Per-tick estimate for the classifier cap gate: one batch of cheap calls
 *  (~1¢ each, rounded up). Backpressure, not accounting — each call's real cost
 *  is recorded after it completes. Mirrors x-intern. */
export const CLASSIFIER_TICK_ESTIMATE_CENTS = 10;

/**
 * Cap gate for one classifier tick. Returns the `BudgetExceededError` when the
 * org/instance is at its cap on the `classifier` bucket (the caller skips the
 * tick), or `null` to proceed. Non-budget errors propagate so the run is
 * recorded as failed rather than silently skipped.
 *
 * Only meaningful on the Noelle-billed path — a BYO-key org pays Google
 * directly, so the worker does not gate it on the Noelle budget.
 * claude-cli is likewise never gated: it runs on the flat-rate local Claude
 * subscription and records cents=0, so blocking it protects no money — while
 * paid spend left over from a claude-cli outage window (when calls billed to
 * Bedrock) would otherwise freeze $0 classification for the rest of the
 * month. Mirrors callAgentModel's skipCap.
 */
export async function classifierBudgetBlock(
  adapters: CapAdapters,
  args: {
    orgId: string;
    instanceId: string;
    /** Engine the Noelle-billed path bills under (recordEngine). */
    engine?: "vertex" | "bedrock" | "claude-cli";
  },
): Promise<BudgetExceededError | null> {
  if (args.engine === "claude-cli") return null;
  try {
    await assertWithinCap(
      {
        bucket: "classifier",
        orgId: args.orgId,
        instanceId: args.instanceId,
        estimatedCents: CLASSIFIER_TICK_ESTIMATE_CENTS,
      },
      adapters,
    );
    return null;
  } catch (err) {
    if (err instanceof BudgetExceededError) return err;
    throw err;
  }
}

/**
 * Classify a single claimed LinkedIn lead.
 *
 * English-only gate (always on): a post detected as non-English is skipped
 * (status 'skipped', reply_kind 'skip', skip_reason='non-english') before any
 * LLM call, so it never reaches the drafter. The detector is lenient on short /
 * emoji / ambiguous text (those pass through as English).
 *
 * Otherwise scores the post with the quality engine, then advances the lead:
 *   - reply_kind 'substantial' | 'light' → status 'classified' (drafter claims).
 *   - reply_kind 'skip'                   → status 'skipped'   (terminal).
 *
 * The engine fails open to substantial/T3 (q=null) on any backend error so a
 * high-signal post is never silently lost when scoring is down. Admission failures stop work.
 * Backend admission and receipts are owned by the worker's shared metered backend.
 */
export async function classifyOneLead(deps: {
  sql: Sql;
  classifier: Pick<Classifier, "classify"> & Partial<Pick<Classifier, "classifyObserved">>;
  notifier: { notify: (a: { orgId: string; title: string; message: string }) => Promise<unknown> };
  inst: { id: string; org_id: string; notify_low_confidence?: boolean | null };
  lead: LeadRow;
  log: Pick<Logger, "warn">;
  /** Shared-memory bus (optional). Emits a `lead.classified` event per lead. */
  bus?: Bus;
  /**
   * Opus-backed drafter (claude -p → Bedrock) for the VIP intro DM. When set and
   * the scout flags dm_soon, the DM is drafted here instead of by the cheap
   * gemini classifier call — so it reads human, not like AI. Omit → no DM drafted.
   */
  runner?: Pick<CodexRunner, "draft">;
}): Promise<void | "jev_unavailable"> {
  const { sql, classifier, notifier, inst, lead, log, bus } = deps;

  const payload = lead.payload as {
    text?: string;
    authorName?: string | null;
    authorHeadline?: string | null;
    reactionCount?: number;
    commentCount?: number;
    /** Discovery lane that produced this lead. The WATCH lane (hand-picked
     *  connections) leaves this unset; the algorithmic lanes stamp it
     *  ('profile_search' = Feeder A ICP guess, 'keyword' = search). */
    source?: string;
  };
  const postText = payload.text ?? "";

  // English-only gate (always on) — runs BEFORE any LLM call. The operator only
  // wants English leads; a non-English post (e.g. a French connection's update)
  // would otherwise get a non-English draft. We skip it here so it never reaches
  // the drafter. Applies to every lead regardless of priority (watch-lane
  // connections included) — non-English is dropped even for watched people. The
  // priority clamp below only protects the QUALITY skip, not the language gate.
  // (Watch-lane leads are priority=true; see the clamp.) The detector
  // is lenient on short / emoji / ambiguous text (those pass through as English).
  // Non-English is skipped regardless of priority (the operator only wants
  // English leads) — the priority clamp below only protects the QUALITY skip.
  const lang = detectLanguage(postText);
  if (lang.isNonEnglish) {
    await markLeadClassified(sql, {
      leadId: lead.id,
      replyKind: "skip",
      score: null,
      tier: null,
      classifierMeta: {
        skip_reason: "non-english",
        reply_kind: "skip",
        reason: `non-english (${lang.reason})`,
        language: { reason: lang.reason, signals: lang.signals },
      },
    });
    await bus?.emit({
      topic: "lead.classified",
      worker: "classifier",
      summary: "skipped non-english",
      payload: { lead_id: lead.id, reply_kind: "skip", tier: null, skip_reason: "non-english" },
      correlationId: lead.id,
    });
    return;
  }

  const observed = payload.source === "extension_observed";
  const input = {
    postText,
    authorName: payload.authorName ?? null,
    authorHeadline: payload.authorHeadline ?? null,
    ...(Number.isSafeInteger(payload.reactionCount) ? { reactionCount: payload.reactionCount } : {}),
    ...(Number.isSafeInteger(payload.commentCount) ? { commentCount: payload.commentCount } : {}),
  };
  // Browser observations are a separate lane: an outage cannot become the
  // legacy classifier's fail-open substantial verdict. Leave the observation
  // queued so Jev can retry after recovery.
  const cls = observed
    ? await classifier.classifyObserved?.(input) ?? null
    : await classifier.classify(input);
  if (observed && (!cls || cls.provider !== "jev")) {
    await markLeadStatus(sql, {
      leadId: lead.id,
      status: "observed",
      meta: { jev_retry: "unavailable", jev_retry_at: new Date().toISOString() },
    });
    log.warn({ leadId: lead.id }, "Jev unavailable; observed post retained for retry");
    return "jev_unavailable";
  }
  if (!cls) return;

  // Priority clamp: a lead from a person the operator HAND-PICKED — a watched
  // CONNECTION (watch lane) — is never hard-skipped on a borderline post. The
  // PERSON is the gate, not the post, so a 'skip' verdict on their post is
  // clamped to 'light' (a short supportive comment). Substantial/tier verdicts
  // pass through unchanged.
  //
  // Two guards keep the priority clamp from rescuing unrelated posts:
  //   1. Only genuine watchlist connections are rescued. The WATCH lane leaves
  //      payload.source unset; the ALGORITHMIC lanes ('profile_search' Feeder A
  //      ICP guesses, 'keyword' search) stamp a source and are NOT hand-picked,
  //      so their off-topic/hiring posts honour the classifier's skip. A guessed
  //      author is not "a chosen watchlist person".
  //   2. Even a hand-picked connection's off-topic or hiring post (q below
  //      CLAMP_MIN_Q) is left as a skip — only genuine-but-lightly-scored posts
  //      (milestones) are rescued. A null q (fail-open scoring outage) clears the
  //      floor so a watched person's post is never dropped on an outage.
  const isWatchlistConnection = !observed && payload.source == null;
  const aboveOffTopicFloor = cls.q == null || cls.q >= CLAMP_MIN_Q;
  const clamped =
    lead.priority &&
    cls.reply_kind === "skip" &&
    isWatchlistConnection &&
    aboveOffTopicFloor;
  const replyKind = clamped ? "light" : cls.reply_kind;
  const tier = clamped ? null : cls.tier;
  const identityPending = observed && replyKind !== "skip" &&
    !hasCanonicalObservedIdentity(lead, lead.payload);


  // Normalise the 0-100 q into a 0-1 score before storing — the shared approval
  // UI does Math.round(score * 100), so a raw q=78 rendered as "7800/100". Match
  // the X intern, which stores 0-1. null when unscored (NULL, not a fake 0).
  // VIP intro DM: the scout (gemini) decided WHO + WHETHER; draft the actual DM
  // with Opus (claude -p → Bedrock) so it reads human, not like a flash one-shot.
  // Fail-open — any miss leaves suggested_dm null and the banner still flags the VIP.
  let vip = cls.vip;
  if (vip?.dm_soon && deps.runner) {
    const dm = await draftVipIntroDm({
      runner: deps.runner,
      orgId: inst.org_id,
      instanceId: inst.id,
      authorName: payload.authorName ?? lead.author_handle,
      authorHeadline: payload.authorHeadline ?? null,
      postText,
      why: vip.reason,
    });
    vip = { ...vip, suggested_dm: dm };
  }

  await markLeadClassified(sql, {
    leadId: lead.id,
    replyKind,
    score: cls.q == null ? null : cls.q / 100,
    tier,
    // Persist the engagement-bait verdict so the drafter can ignore an inflated
    // comment count when deciding Opus. Defaults false on every fail-open path.
    commentBait: cls.comment_bait,
    // Relationship-scout verdict (null when the scout is off or the call
    // fail-opened) → persisted to leads.vip_signal for the approvals banner.
    // suggested_dm is now drafted above with Opus, not by the gemini scout.
    vipSignal: vip,
    identityPending,
    classifierMeta: {
      ...(cls.raw as Record<string, unknown>),
      provider: cls.provider ?? "legacy",
      q: cls.q,
      reply_kind: replyKind,
      tier,
      comment_bait: cls.comment_bait,
      reason: clamped ? `${cls.reason} (priority-clamped skip→light)` : cls.reason,
      // The model's raw verdict before the priority clamp, for observability.
      ...(clamped ? { raw_reply_kind: cls.reply_kind, priority_clamped: true } : {}),
    },
  });
  if (observed && replyKind !== "skip" && !identityPending) {
    // The drafter also polls, so a transient NOTIFY failure does not lose the
    // qualified lead. Notification only removes avoidable poll latency.
    await sql`select pg_notify(${'noelle_linkedin_priority'}, ${inst.id})`.catch((err) =>
      log.warn({ leadId: lead.id, err: (err as Error).message }, "priority drafter wake failed"),
    );
  }
  await bus?.emit({
    topic: "lead.classified",
    worker: "classifier",
    summary: `classified ${tier ?? replyKind}`,
    payload: { lead_id: lead.id, reply_kind: replyKind, tier, score: cls.q },
    correlationId: lead.id,
  });

  // notify_low_confidence: ping when the classifier decided to SKIP a lead, so
  // the operator can eyeball borderline drops. Best-effort; notifier.notify()
  // returns status='no_channel' rather than throwing when no keys exist.
  if (inst.notify_low_confidence && replyKind === "skip") {
    await notifier
      .notify({
        orgId: inst.org_id,
        title: `Skipped lead · ${lead.author_handle}`,
        message: `Classifier skipped a post (q=${cls.q ?? "—"}).\n${cls.reason}`,
      })
      .catch((err) => {
        log.warn(
          { leadId: lead.id, err: (err as Error).message },
          "notify low-confidence failed",
        );
      });
  }
}
