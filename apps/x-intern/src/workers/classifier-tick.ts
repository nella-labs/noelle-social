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
