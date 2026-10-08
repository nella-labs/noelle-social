// Follower-floor policy for the X-intern classifier.
//
// Low-follower authors are graded more strictly — a reply to a 30-follower account is
// rarely worth it, and very small accounts skew toward bots/slop. See the table in
// docs/classifier-grading.md. Pure function; thresholds are the knobs.
//
// Fail-safe: an UNKNOWN follower count (null/undefined) is neutral, never a drop. A
// follower-extraction miss must not silently nuke every lead.

export type Tier = "T1" | "T2" | "T3" | null;

/**
 * The ONLY thing that rescues a post flagged as AI slop: an author with more
 * than this many followers. Below it (or unknown), a slop flag means the lead
 * is dropped, full stop. Consumed in classifier-tick where slop + followers
 * are combined.
 */
export const SLOP_RESCUE_FOLLOWERS = 1500;

/** Below this, drop the lead outright. */
export const FOLLOWER_DROP_BELOW = 100;
/** Below this (and >= DROP), grade strictly: only strong, non-slop T1 survives. */
export const FOLLOWER_STRICT_BELOW = 500;
/** Below this (and >= STRICT), apply only a mild score penalty. */
export const FOLLOWER_MILD_BELOW = 1000;

const STRICT_SCORE_FACTOR = 0.7;
const MILD_SCORE_FACTOR = 0.85;

export type FollowerBucket = "unknown" | "drop" | "strict" | "mild" | "full";

export interface FollowerPolicyInput {
  followers: number | null | undefined;
  onBrand: boolean;
  tier: Tier;
  /** 0..1 classifier score, or null when unscored. */
  score: number | null;
  /** AI-slop verdict from the deterministic detector. */
  isSlop: boolean;
}

export interface FollowerPolicyResult {
  onBrand: boolean;
  tier: Tier;
  score: number | null;
  bucket: FollowerBucket;
  reason: string;
}

/** Demote a tier one step toward T3 (null stays null). */
function demote(tier: Tier): Tier {
  if (tier === "T1") return "T2";
  if (tier === "T2") return "T3";
  return tier;
}

function penalise(score: number | null, factor: number): number | null {
  return score == null ? null : score * factor;
}

/**
 * Adjust a classifier grade by the author's follower count. Never resurrects an
 * already off-brand lead; only ever demotes or drops.
 */
export function applyFollowerPolicy(input: FollowerPolicyInput): FollowerPolicyResult {
  const { followers, onBrand, tier, score, isSlop } = input;

  // Unknown follower count → neutral. Missing data is not evidence.
  if (followers == null || !Number.isFinite(followers)) {
    return { onBrand, tier, score, bucket: "unknown", reason: "followers unknown — neutral" };
  }

  if (followers < FOLLOWER_DROP_BELOW) {
    return {
      onBrand: false,
      tier,
      score,
      bucket: "drop",
      reason: `under ${FOLLOWER_DROP_BELOW} followers (${followers}) — dropped`,
    };
  }

  if (followers < FOLLOWER_STRICT_BELOW) {
    // Strict: survives only as a strong, non-slop T1 signal that was already on-brand.
    const survives = onBrand && tier === "T1" && !isSlop;
    return {
      onBrand: survives,
      tier: survives ? demote(tier) : tier,
      score: penalise(score, STRICT_SCORE_FACTOR),
      bucket: "strict",
      reason: survives
        ? `${followers} followers — strict: kept strong T1, demoted to T2`
        : `${followers} followers — strict: weak/slop signal dropped`,
    };
  }

  if (followers < FOLLOWER_MILD_BELOW) {
    // Mild: small score penalty, tier untouched. "Don't punish much."
    return {
      onBrand,
      tier,
      score: penalise(score, MILD_SCORE_FACTOR),
      bucket: "mild",
      reason: `${followers} followers — mild penalty`,
    };
  }

  return { onBrand, tier, score, bucket: "full", reason: `${followers} followers — full credit` };
}
