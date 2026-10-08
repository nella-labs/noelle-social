import type { Rng } from "./rng.js";

// The idle-engagement kinds the Reddit actuator can deliver in the WAITS between
// replies (idle-only, never coupled to a reply — exactly like an upvote):
//   upvote → the post's upvote arrow (the dominant, default path; a single click,
//            no menu). See selectors.findUpvoteButton.
//   save   → a private post-SAVE via the post's overflow "…" (more) menu (new
//            Reddit) or the `.save-button` link (old Reddit). A save is a
//            BOOKMARK, NOT a vote — it does not touch the Reddit vote-manipulation
//            ToS clause the upvote path already skirts (a downvote would). Slightly
//            higher effort (a two-step menu on new Reddit), so it ships DEFAULT-OFF.
// `label` is the visible word, used only for the panel string / diagnostics.
// There is deliberately NO 'downvote' kind — downvoting is never modeled, located,
// or delivered ANYWHERE in the actuator. This enum is SAVE-ONLY on the write side.
export type EngagementKind = "upvote" | "save";

export interface EngagementDef {
  kind: EngagementKind;
  label: string;
  /** Default relative weight in the weighted pick (need not sum to anything). */
  weight: number;
}

// Default mix: ALWAYS a plain upvote. The upvote itself is operator opt-in but
// DEFAULT-ON (see ActuatorConfig.upvotesEnabled); the save mix layered on top
// ships DEFAULT-OFF — the operator must raise `save` in `engagementWeights`
// before a single post-save is ever delivered. Absent / all-zero ⇒ upvote-only,
// byte-identical to the pre-save behavior. Mirrors the X actuator's default-OFF
// bookmark/repost mix (apps/x-actuator/src/lib/engagement.ts): a save adds write
// volume and a menu interaction, so the operator opts in per-config first.
export const ENGAGEMENTS: readonly EngagementDef[] = [
  { kind: "upvote", label: "Upvote", weight: 100 },
  { kind: "save", label: "Save", weight: 0 },
] as const;

const BY_KIND = new Map<EngagementKind, EngagementDef>(ENGAGEMENTS.map((e) => [e.kind, e]));

/** The visible label for an engagement kind (e.g. "save" → "Save"). */
export function engagementLabel(kind: EngagementKind): string {
  return BY_KIND.get(kind)?.label ?? "Upvote";
}

/**
 * Weighted-random engagement. Uses each kind's default weight, overridable
 * per-kind via `overrides` (an operator-tuned mix from config) — a missing or
 * non-finite override falls back to the default weight; a zero disables that
 * kind. If every weight collapses to zero we return "upvote" (the safe default
 * the actuator can always deliver with a single click, no menu). Because the
 * default weights are upvote=100 / save=0, the default behavior is ALWAYS a plain
 * upvote until the operator opts in — the DEFAULT-OFF guarantee. SAVE-ONLY: the
 * only non-upvote kind this can ever return is "save"; there is no downvote kind.
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
  if (weights.every((w) => w === 0)) return "upvote";
  return ENGAGEMENTS[rng.pickWeighted(weights)]!.kind;
}
