import type { Rng } from "./rng.js";

// The engagement kinds the X actuator can deliver on a liked tweet, keyed by the
// data-testid X stamps on each action-bar button (the most drift-resistant hook):
//   like     → data-testid='like'      (the ❤ heart; the dominant, default path)
//   bookmark → data-testid='bookmark'  (private save; low-risk but adds write volume)
//   repost   → data-testid='retweet'   (PUBLIC amplification under the account's own
//              name → reputational + spam-signal risk; a two-step confirm menu)
// `label` is the visible word, used only for the panel string / diagnostics.
export type EngagementKind = "like" | "bookmark" | "repost";

export interface EngagementDef {
  kind: EngagementKind;
  label: string;
  /** Default relative weight in the weighted pick (need not sum to anything). */
  weight: number;
}

// Default mix. Lyra varies her gesture across six reactions; Vega delivered a
// plain Like 100% of the time, which is its own small monotony signal. The two
// non-like kinds are NOT equivalent on X, so they are treated differently:
//
//   bookmark — PRIVATE, no public footprint, one click, no confirm menu. Because
//     pickEngagement chooses ONE action, a bookmark REPLACES a like rather than
//     adding to it: same write count, and arguably a lower-risk write than the
//     like it displaces. Enabled at a modest weight so the gesture genuinely
//     varies (~12% of engagements).
//   repost — PUBLIC amplification under the operator's own name. That is a
//     content decision, not a humanisation detail: it puts someone else's post
//     on the operator's timeline. Stays at 0; the operator must opt in explicitly.
//
// See docs/x-account-safety.md §9.
export const ENGAGEMENTS: readonly EngagementDef[] = [
  { kind: "like", label: "Like", weight: 88 },
  { kind: "bookmark", label: "Bookmark", weight: 12 },
  { kind: "repost", label: "Repost", weight: 0 },
] as const;

const BY_KIND = new Map<EngagementKind, EngagementDef>(ENGAGEMENTS.map((e) => [e.kind, e]));

/** The visible label for an engagement kind (e.g. "repost" → "Repost"). */
export function engagementLabel(kind: EngagementKind): string {
  return BY_KIND.get(kind)?.label ?? "Like";
}

/**
 * Weighted-random engagement. Uses each kind's default weight, overridable
 * per-kind via `overrides` (an operator-tuned mix from config) — a missing or
 * non-finite override falls back to the default weight; a zero disables that
 * kind. If every weight collapses to zero we return "like" (the safe default the
 * actuator can always deliver with a single click, no menu). Because the default
 * weights are like=100 / bookmark=0 / repost=0, the default behavior is ALWAYS a
 * plain Like until the operator opts in.
 */
export function pickEngagement(
  rng: Rng,
  overrides?: Partial<Record<EngagementKind, number>>,
): EngagementKind {
  const weights = ENGAGEMENTS.map((e) => {
    const o = overrides?.[e.kind];
    const w = typeof o === "number" && Number.isFinite(o) ? o : e.weight;
    return w > 0 ? w : 0;
  });
  if (weights.every((w) => w === 0)) return "like";
  return ENGAGEMENTS[rng.pickWeighted(weights)]!.kind;
}
