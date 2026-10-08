import type { Rng } from "./rng.js";

// LinkedIn's six post reactions, keyed by the Voyager `reactionType` enum (the
// value LinkedIn puts on each flyout button's `data-reaction-type`, the most
// drift-resistant selector). `label` is the visible/aria word the button also
// carries, so the content locator can fall back to a label match when the data
// attribute is renamed. Ordering matches the flyout left→right.
export type ReactionType =
  | "LIKE"
  | "PRAISE"
  | "EMPATHY"
  | "APPRECIATION"
  | "INTEREST"
  | "ENTERTAINMENT";

export interface ReactionDef {
  type: ReactionType;
  /** The visible/aria label LinkedIn renders (e.g. "Celebrate", "Support"). */
  label: string;
  /** Default relative weight in the weighted pick (need not sum to anything). */
  weight: number;
}

// Default mix: still overwhelmingly a Like, but with a real tail. The operator
// asked for an inclination toward Like, Support, and applause (Celebrate), so
// those three carry the weight; Love/Insightful/Funny are the occasional spice.
// Relative weights (≈%): LIKE 70, Celebrate 10, Support 10, Love 4, Insightful 4,
// Funny 2 → ~30% of reactions are non-Like, dominated by Support + Celebrate.
export const REACTIONS: readonly ReactionDef[] = [
  { type: "LIKE", label: "Like", weight: 70 },
  { type: "PRAISE", label: "Celebrate", weight: 10 }, // 👏 the "applause" reaction
  { type: "EMPATHY", label: "Support", weight: 10 }, // 🫶 the "support" reaction
  { type: "APPRECIATION", label: "Love", weight: 4 },
  { type: "INTEREST", label: "Insightful", weight: 4 },
  { type: "ENTERTAINMENT", label: "Funny", weight: 2 },
] as const;

const BY_TYPE = new Map<ReactionType, ReactionDef>(REACTIONS.map((r) => [r.type, r]));

/** The visible label for a reaction type (e.g. "PRAISE" → "Celebrate"). */
export function reactionLabel(type: ReactionType): string {
  return BY_TYPE.get(type)?.label ?? "Like";
}

/**
 * Weighted-random reaction. Uses each reaction's default weight, overridable
 * per-type via `overrides` (an operator-tuned mix from config) — a missing or
 * non-finite override falls back to the default weight; a zero disables that
 * reaction. If every weight collapses to zero we return LIKE (the safe default
 * the actuator can always deliver with a single click, no flyout).
 */
export function pickReaction(
  rng: Rng,
  overrides?: Partial<Record<ReactionType, number>>,
): ReactionType {
  const weights = REACTIONS.map((r) => {
    const o = overrides?.[r.type];
    const w = typeof o === "number" && Number.isFinite(o) ? o : r.weight;
    return w > 0 ? w : 0;
  });
  if (weights.every((w) => w === 0)) return "LIKE";
  return REACTIONS[rng.pickWeighted(weights)]!.type;
}
