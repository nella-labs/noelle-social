import { readXSourceTimestamp } from "@noelle/x-client";

/**
 * Post-age policy for the classifier.
 *
 * Two levers, both keyed off the tweet's own creation time
 * (`leads.payload.posted_at`, an ISO string set at discovery):
 *
 *  1. Hard cutoff — a post older than MAX_LEAD_AGE_DAYS is discarded BEFORE any
 *     classification work (no LLM call, no approval row). Replying to a
 *     two-week-old tweet is noise, so it never reaches the inbox.
 *
 *  2. Recency weighting — among posts inside the window, fresher posts rank
 *     higher. We fold a recency multiplier into the classifier score so the
 *     inbox's "score desc" order naturally floats today's posts above last
 *     week's at equal base quality. The multiplier is bounded to (0, 1] so the
 *     score stays a valid 0-1 value.
 *
 * Both functions are pure and take an explicit `now` so they're trivially
 * testable and deterministic.
 */

/** Posts older than this (by their own posted_at) are dropped pre-classification. */
export const MAX_LEAD_AGE_DAYS = 15;

/**
 * How hard recency decays the score across the window. At age 0 the multiplier
 * is 1.0; at MAX_LEAD_AGE_DAYS it bottoms out at (1 - RECENCY_DECAY). 0.5 keeps
 * a 15-day-old post at half the weight of a same-quality post from today —
 * enough to order by freshness without burying genuinely good older leads.
 */
export const RECENCY_DECAY = 0.5;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function parsePostedAt(postedAt: unknown): Date | null {
  const timestamp = readXSourceTimestamp(postedAt);
  return timestamp ? new Date(timestamp) : null;
}

export interface LeadAge {
  /** Parsed age in days (fractional), or null when posted_at is missing/unparseable. */
  ageDays: number | null;
  /** True only when we can prove the post is older than MAX_LEAD_AGE_DAYS. */
  expired: boolean;
  /** The normalised ISO timestamp we parsed, for logging/meta. */
  postedAtIso: string | null;
}

/**
 * Age of a lead's post relative to `now`. A missing or unparseable posted_at is
 * never treated as expired — we don't drop a lead we can't date (fail-open).
 */
export function leadAge(postedAt: unknown, now: Date): LeadAge {
  const d = parsePostedAt(postedAt);
  if (!d) return { ageDays: null, expired: false, postedAtIso: null };
  const ageDays = (now.getTime() - d.getTime()) / MS_PER_DAY;
  return {
    ageDays,
    expired: ageDays > MAX_LEAD_AGE_DAYS,
    postedAtIso: d.toISOString(),
  };
}

/**
 * Recency multiplier in (1 - RECENCY_DECAY, 1] for a post inside the window.
 * Fresh (age 0) → 1.0; older → smaller. A post in the future (clock skew) or an
 * undateable post gets 1.0 (no penalty). Ages past the window are clamped to the
 * floor — callers should have already dropped those via `leadAge().expired`.
 */
export function recencyMultiplier(postedAt: unknown, now: Date): number {
  const d = parsePostedAt(postedAt);
  if (!d) return 1;
  const ageDays = (now.getTime() - d.getTime()) / MS_PER_DAY;
  if (ageDays <= 0) return 1;
  const fraction = Math.min(1, ageDays / MAX_LEAD_AGE_DAYS);
  return 1 - RECENCY_DECAY * fraction;
}

/**
 * Apply the recency weighting to a base classifier score. Null score (unscored)
 * stays null; otherwise the multiplier scales it and the result is clamped to
 * [0, 1].
 */
export function applyRecency(
  baseScore: number | null,
  postedAt: unknown,
  now: Date,
): number | null {
  if (baseScore == null) return null;
  const weighted = baseScore * recencyMultiplier(postedAt, now);
  return Math.max(0, Math.min(1, weighted));
}
