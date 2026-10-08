import type { Sql } from "postgres";
import { assertWithinCap, BudgetExceededError, type Bus, type CapAdapters } from "@noelle/runtime";
import type { Logger } from "../lib/logger.js";
import type { LeadRow } from "../lib/leads-db.js";
import type { Classifier } from "../lib/classifier-engine.js";
import { markLeadClassified, markLeadStatus } from "../lib/leads-db.js";
import { detectAiSlop } from "../lib/ai-slop.js";
import { draftVipIntroDm } from "../lib/vip-dm.js";
import type { CodexRunner } from "../lib/codex-runner.js";
import { applyFollowerPolicy, SLOP_RESCUE_FOLLOWERS } from "../lib/follower-policy.js";
import {
  classificationEligibility,
  type ClassificationEligibility,
} from "../lib/classification-eligibility.js";

/**
 * Off-topic floor for the priority clamp (q on the 0-100 scale). A hand-picked
 * watchlist person's post is rescued from a 'skip' verdict only at or above this
 * score — an off-topic or promo post from someone the operator follows is still a skip,
 * so "the person is the gate" never becomes "reply to anything they post".
 * Override with NOELLE_X_CLAMP_MIN_Q. Mirrors Lyra's NOELLE_LI_CLAMP_MIN_Q.
 */
// Number("abc") is NaN and every `q >= NaN` is false, which would silently turn
// the clamp OFF (no watchlist lead would ever be rescued) instead of failing
// loudly. Fall back to the default on any non-finite value.
const RAW_CLAMP_MIN_Q = Number(process.env.NOELLE_X_CLAMP_MIN_Q ?? 25);
const CLAMP_MIN_Q = Number.isFinite(RAW_CLAMP_MIN_Q) ? RAW_CLAMP_MIN_Q : 25;
import { applyRecency } from "../lib/recency.js";

/** Per-tick estimate for the classifier cap gate: one batch of cheap Gemini
 *  calls (~1¢ each, rounded up). Backpressure, not accounting — each call's
 *  real cost is recorded after it completes. */
export const CLASSIFIER_TICK_ESTIMATE_CENTS = 10;

/**
 * Cap gate for one classifier tick. Returns the `BudgetExceededError` when the
 * org/instance is at its cap on the `classifier` bucket (the caller skips the
 * tick), or `null` to proceed. Non-budget errors propagate so the run is
 * recorded as failed rather than silently skipped.
 *
 * Only meaningful on the Noelle-billed path — a BYO-key org pays Google
 * directly, so the worker does not gate it on the Noelle budget.
 *
 * claude-cli USED to be exempt here, on the premise that it runs on a flat-rate
 * subscription and records cents=0 so blocking it protects no money. Both
 * halves of that stopped being true: it records the CLI's own total_cost_usd,
 * and the money it protects is a weekly allowance rather than an invoice. The
 * matching exemption in callAgentModel is already gone; this was the last copy,
 * and it let the classifier claim a batch of leads and then fail call-by-call
 * instead of skipping the tick cleanly.
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
 * Classify (or pass-through) a single claimed lead.
 *
 * English-only gate (always on): a post whose text is detected as non-English is
 * skipped (status 'skipped', label 'non_english', skip_reason='non-english')
 * before any model call and before watchlist protection — so even a watched
 * person's non-English post is never drafted. The detector is lenient on short /
 * emoji / ambiguous text (those pass through as English).
 *
 * Watchlist (priority) leads are classified like any other lead and then
 * protected: a skip at the configured topic floor can become 'light', and
 * the slop and follower floors are exempted. Model budget admission still applies.
 *
 * Backend admission and receipts are owned by the worker's shared metered backend.
 */
export async function classifyOneLead(deps: {
  sql: Sql;
  classifier: Pick<Classifier, "classify"> & Partial<Pick<Classifier, "classifyObserved">>;
  notifier: { notify: (a: { orgId: string; title: string; message: string }) => Promise<unknown> };
  inst: { id: string; org_id: string; notify_low_confidence?: boolean | null; icp_config?: unknown; classifier_threshold?: number | null };
  lead: LeadRow;
  log: Pick<Logger, "warn">;
  observedThreshold?: number;
  /** Prepared by the supervisor before a batch call; single posts use the same rules. */
  eligibility?: ClassificationEligibility;
  /** Shared-memory bus (optional). Emits a `lead.classified` event per lead. */
  bus?: Bus;
  /**
   * Opus-backed drafter (claude -p → Bedrock) for the VIP intro DM. When set and
   * the scout flags dm_soon, the DM is drafted here instead of by the cheap
   * gemini classifier call — so it reads human, not like AI. Omit → no DM drafted.
   */
  runner?: Pick<CodexRunner, "draft">;
}): Promise<"jev_unavailable" | void> {
  const { sql, classifier, notifier, inst, lead, log, bus } = deps;
  const emitClassified = (label: string, tier: string | null, onBrand: boolean) =>
    bus?.emit({
      topic: "lead.classified",
      worker: "classifier",
      summary: `classified ${tier ?? label}`,
      payload: { lead_id: lead.id, label, tier, on_brand: onBrand },
      correlationId: lead.id,
    });

  const eligibility = deps.eligibility ?? classificationEligibility(lead, inst);
  const { observed, age } = eligibility;
  if (eligibility.drop) {
    await markLeadClassified(sql, {
      leadId: lead.id,
      label: eligibility.drop.label,
      score: null,
      tier: null,
      onBrand: false,
      classifierMeta: eligibility.drop.meta,
    });
    await emitClassified(eligibility.drop.label, null, false);
    return;
  }
  const payload = lead.payload as {
    text?: string;
    source?: string;
    author_followers?: number | null;
  };
  const postText = payload.text ?? "";
  const followers = payload.author_followers ?? null;
  const postedAt = lead.payload.posted_at;

  const input = {
    postText,
    authorHandle: lead.author_handle,
    source: "x" as const,
    velocityAtDiscovery: 0,
    authorFollowers: followers,
  };
  // A saved per-instance threshold is authoritative. Without one, retain the
  // browser lane's historical 80% floor even when X_Q_THRESHOLD is lower.
  const observedThreshold = inst.classifier_threshold ?? Math.max(80, deps.observedThreshold ?? 80);
  const cls = observed
    ? await classifier.classifyObserved?.(input, observedThreshold) ?? null
    : await classifier.classify(input);
  if (observed && (!cls || (cls.raw as { judge?: string })?.judge !== "jev")) {
    await markLeadStatus(sql, {
      leadId: lead.id, status: "observed",
      meta: { jev_retry: "unavailable", jev_retry_at: new Date().toISOString() },
    });
    log.warn({ leadId: lead.id }, "Jev unavailable; observed X post retained for retry");
    return "jev_unavailable";
  }
  if (!cls) return;
  // Deterministic AI-slop filter (runs even on a fail-open call — it's free and
  // doesn't depend on the LLM). It's the authoritative slop signal; the LLM's
  // ai_slop is folded in too. Either one drops the lead.
  const slop = detectAiSlop(postText);
  const isSlop = slop.isSlop || cls.ai_slop;

  // The ONLY thing that rescues an AI-slop post is a big follower count
  // (> SLOP_RESCUE_FOLLOWERS). Unknown or smaller → the slop flag drops it.
  const slopRescued = isSlop && followers != null && followers > SLOP_RESCUE_FOLLOWERS;
  // A hand-picked watchlist person is NEVER dropped on a slop verdict. The old
  // bypass returned before detectAiSlop ran at all, so removing it silently
  // exposed watched authors to a detector tuned for strangers — and it
  // false-positives on genuine human posts (measured over the live priority
  // leads: 56 flagged, 11 would have dropped, 10 of which were actually drafted
  // and sent; the tells were em-dash density and mass-mentions on real posts).
  // The flag is still recorded in classifierMeta for auditing; it just stops
  // being terminal for someone the operator chose.
  // A NOTIFICATION lead is someone who replied to US, so it is a conversation,
  // not cold discovery — and it gets the same protection a hand-picked watchlist
  // person does. This matters because the classifier's own rules are written for
  // COLD discovery and actively disqualify a conversation: SYSTEM_X lists
  // "replies to threads" as off-brand, and a notification lead is BY DEFINITION
  // a reply. Measured on the live data, that killed the entire lane — 8 of 8
  // notification leads were classified 'reply'/'other' and skipped, so the
  // notifications actor produced nothing at all.
  const isConversation = (payload as { source?: string }).source === "notification";
  const protectedLead = (!observed && (lead.priority ?? false)) || isConversation;
  const slopDrop = isSlop && !slopRescued && !protectedLead;

  // PRIORITY CLAMP (ported from Lyra #323). A watchlist lead used to BYPASS the
  // classifier entirely with a forged score=1 / tier=T1, so ~70% of Vega's
  // drafted output was never graded and could not be filtered on quality at all.
  // Now every lead is classified and the hand-picked ones are merely PROTECTED:
  // a 'skip' verdict on their post is softened to 'light' (a short warm reply)
  // rather than dropping it, because the PERSON is the gate, not the post.
  //
  // Two guards keep that from drafting off-topic noise:
  //   1. On X, priority=true means the author is in the watchlist people list
  //      and posted on/after the day they were added (discovery-tick.ts:315) —
  //      i.e. genuinely hand-picked. X has no algorithmic author lane, so unlike
  //      LinkedIn there is no payload.source discriminator to apply.
  //   2. An OFF-TOPIC post from a hand-picked person is still skipped: the
  //      rescue only fires at or above CLAMP_MIN_Q. A null q (a fail-open
  //      scoring outage) clears the floor, so a watched person is never dropped
  //      because the classifier was down.
  // A null q means the classifier could not score (fail-open path). Treat that as
  // clearing the floor so a watched person is never dropped because scoring was
  // down. NOTE: the engine's fail-open also forces reply_kind='substantial', so
  // this disjunct is belt-and-braces rather than the live outage path — the
  // outage protection that actually matters is the slop/follower exemption above.
  const aboveOffTopicFloor = cls.q == null || cls.q >= CLAMP_MIN_Q;
  const clamped = protectedLead && cls.reply_kind === "skip" && aboveOffTopicFloor && !slopDrop;
  const replyKind = clamped ? "light" : cls.reply_kind;

  // Base grade: LLM verdict with the (rescued-aware) slop verdict folded in.
  // A clamped lead is on-brand by definition (we chose to answer it).
  const baseOnBrand = (cls.on_brand && replyKind !== "skip" && !slopDrop) || clamped;
  // Score on REPLY-WORTHINESS (q), not the velocity proxy. Velocity predicts
  // whether a post will blow up; q asks whether we should answer it, which is
  // the question the drafter's quality gate is actually asking. Velocity is
  // still recorded in classifierMeta for observability.
  const baseScore = cls.q == null ? null : cls.q / 100;

  // Follower floor: drop tiny accounts, grade small ones strictly, full credit
  // for 1000+. Unknown follower count is neutral (never a drop).
  const fp = applyFollowerPolicy({
    // The follower floor grades STRANGERS. A watchlist person was hand-picked by
    // the operator, so their follower count is not a second opinion on whether
    // to engage — null is the policy's documented neutral bucket (never a drop).
    // The old bypass short-circuited this entirely; without the exemption,
    // removing it would silently skip small watched authors. The true count is
    // still recorded in classifierMeta.follower_policy below.
    followers: protectedLead ? null : followers,
    onBrand: baseOnBrand,
    // Only a SUBSTANTIAL lead carries a tier; light/clamped leads are tier-null
    // so the drafter's Opus escalation does not fire on a short congrats.
    tier: replyKind === "substantial" ? cls.tier : null,
    score: baseScore,
    isSlop: slopDrop,
  });

  const finalOnBrand = fp.onBrand;
  // Recency weighting: fold the post's freshness into the score so the inbox's
  // "score desc" order floats today's posts above last week's at equal base
  // quality. Bounded to [0,1]; null (unscored) stays null. Browser observations
  // retain their reviewed score without the legacy age weighting.
  const recencyScore = observed ? fp.score : applyRecency(fp.score, postedAt, new Date());
  const reasonBits = [
    cls.on_brand_reason,
    isSlop
      ? `ai_slop(${[slop.isSlop ? "detector" : null, cls.ai_slop ? "llm" : null].filter(Boolean).join("+")})${slopRescued ? ` — rescued by ${followers} followers` : ""}`
      : null,
    fp.bucket !== "unknown" && fp.bucket !== "full" ? fp.reason : null,
  ].filter(Boolean);

  // VIP intro DM: the scout (gemini) decided WHO + WHETHER; draft the actual DM
  // with Opus (claude -p → Bedrock) so it reads human, not like a flash one-shot.
  // Fail-open — any miss leaves suggested_dm null and the banner still flags the VIP.
  let vip = cls.vip;
  if (vip?.dm_soon && deps.runner) {
    const dm = await draftVipIntroDm({
      runner: deps.runner,
      orgId: inst.org_id,
      instanceId: inst.id,
      authorHandle: lead.author_handle,
      postText,
      why: vip.reason,
      followers,
    });
    vip = { ...vip, suggested_dm: dm };
  }

  await markLeadClassified(sql, {
    leadId: lead.id,
    // Surface the drop reason in the label so it's legible in the dashboard.
    // 'light' is a first-class label so the drafter can route a short warm
    // reply, and so a clamped watchlist rescue is legible in the dashboard.
    label: slopDrop ? "ai_slop" : replyKind === "light" ? "light" : cls.kind,
    score: recencyScore,
    tier: fp.tier,
    onBrand: finalOnBrand,
    // Engagement-bait: persisted so the drafter can discount an inflated reply
    // count when deciding whether this lead deserves the smarter model.
    commentBait: cls.comment_bait,
    // Relationship-scout verdict (null when the scout is off or the call
    // fail-opened) → persisted to leads.vip_signal for the approvals banner.
    // suggested_dm is now drafted above with Opus, not by the gemini scout.
    vipSignal: vip,
    classifierMeta: {
      ...(cls.raw as Record<string, unknown>),
      recency: { posted_at: age.postedAtIso, age_days: age.ageDays, base_score: fp.score },
      ai_slop: {
        flagged: isSlop,
        dropped: slopDrop,
        rescued_by_followers: slopRescued,
        detector_score: slop.score,
        detector_reasons: slop.reasons,
        llm: cls.ai_slop,
        llm_reason: cls.ai_slop_reason,
      },
      follower_policy: {
        followers,
        bucket: fp.bucket,
        reason: fp.reason,
        ...(protectedLead
          ? { exempt: lead.priority ? "watchlist_priority" : "notification_conversation" }
          : {}),
      },
      // Reply-worthiness routing (the signal the gate now grades on), with the
      // velocity proxy kept alongside so the two stay comparable in the data.
      reply_worthiness: {
        q: cls.q,
        reply_kind: replyKind,
        raw_reply_kind: cls.reply_kind,
        velocity_score: cls.velocity_score,
        comment_bait: cls.comment_bait,
        ...(clamped ? { priority_clamped: true, clamp_min_q: CLAMP_MIN_Q } : {}),
      },
    },
  });
  if (observed && finalOnBrand && replyKind !== "skip") {
    await sql`select pg_notify(${'noelle_x_priority'}, ${inst.id})`.catch((err) =>
      log.warn({ leadId: lead.id, err: (err as Error).message }, "X priority drafter wake failed"),
    );
  }
  await emitClassified(
    slopDrop ? "ai_slop" : replyKind === "light" ? "light" : cls.kind,
    fp.tier,
    finalOnBrand,
  );
  // notify_low_confidence: ping when the lead was judged off-brand (by the LLM,
  // the slop filter, or the follower floor). Best-effort; notifier.notify()
  // returns status='no_channel' rather than throwing when no Pushover keys exist.
  if (inst.notify_low_confidence && !finalOnBrand) {
    await notifier
      .notify({
        orgId: inst.org_id,
        title: `Off-brand lead · @${lead.author_handle}`,
        message: `Classifier dropped lead (${isSlop ? "ai_slop" : cls.kind}, tier ${fp.tier ?? "—"}).\n${reasonBits.join(" · ")}`,
      })
      .catch((err) => {
        log.warn(
          { leadId: lead.id, err: (err as Error).message },
          "notify low-confidence failed",
        );
      });
  }
}
