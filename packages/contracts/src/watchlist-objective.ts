import { z } from "zod";

/**
 * @noelle/contracts — per-watchlist-person objective.
 *
 * A watchlist person (noelle.x_watchlist_people) can carry an objective that
 * steers HOW Vega drafts the reply + DM for that person's posts: a preset
 * `kind` plus an optional free-text `note`. NULL kind = no per-person steer
 * (the drafter falls back to the instance objective only).
 *
 * Single source of truth: the dashboard reads `label` for the picker/chip and
 * the drafter reads `drafterDirective` for the prompt, so the UI copy and the
 * model instruction can never drift.
 */

export const OBJECTIVE_NOTE_MAX = 240;

export interface WatchlistObjective {
  key: "relationship" | "feedback" | "pitch" | "amplify";
  /** Dashboard label (picker + chip). */
  label: string;
  /** Instruction appended to the drafter system prompt for this person. */
  drafterDirective: string;
}

export const WATCHLIST_OBJECTIVES: readonly WatchlistObjective[] = [
  {
    key: "relationship",
    label: "Build relationship",
    drafterDirective:
      "Engage genuinely and stay consistently present about what they ship. Be a supportive peer who clearly follows their work. Do NOT pitch anything.",
  },
  {
    key: "feedback",
    label: "Get feedback / learn",
    drafterDirective:
      "Ask thoughtful, specific questions about their work and build credibility through genuine curiosity. Do NOT pitch.",
  },
  {
    key: "pitch",
    label: "Pitch the product",
    drafterDirective:
      "When their post is genuinely relevant, work Noelle's angle in naturally — never forced, never spammy.",
  },
  {
    key: "amplify",
    label: "Amplify / boost",
    drafterDirective:
      "Champion and signal-boost their post with a supportive, value-adding take that amplifies their reach.",
  },
] as const;

export const WATCHLIST_OBJECTIVE_KINDS = WATCHLIST_OBJECTIVES.map((o) => o.key) as [
  WatchlistObjective["key"],
  ...WatchlistObjective["key"][],
];

/** The preset key (one of the WATCHLIST_OBJECTIVES). */
export const WatchlistObjectiveKindSchema = z.enum(WATCHLIST_OBJECTIVE_KINDS);
export type WatchlistObjectiveKind = z.infer<typeof WatchlistObjectiveKindSchema>;

/** Optional free-text refinement; trimmed and bounded, empty ⇒ null. */
export const WatchlistObjectiveNoteSchema = z
  .string()
  .trim()
  .max(OBJECTIVE_NOTE_MAX, `Note must be ${OBJECTIVE_NOTE_MAX} characters or fewer`)
  .transform((s) => (s.length === 0 ? null : s))
  .nullable();

export function watchlistObjectiveLabel(
  kind: WatchlistObjectiveKind | null | undefined,
): string | null {
  if (!kind) return null;
  return WATCHLIST_OBJECTIVES.find((o) => o.key === kind)?.label ?? null;
}

/**
 * Compose the prompt fragment for a person's objective, layered under the
 * instance objective by the drafter. Returns "" when there's no objective so
 * callers can unconditionally append it.
 */
export function composeObjectiveDirective(
  kind: WatchlistObjectiveKind | null | undefined,
  note?: string | null,
): string {
  if (!kind) return "";
  const entry = WATCHLIST_OBJECTIVES.find((o) => o.key === kind);
  if (!entry) return "";
  const trimmedNote = note?.trim();
  const noteClause = trimmedNote ? ` Operator note: ${trimmedNote}` : "";
  return `Objective for this specific person: ${entry.drafterDirective}${noteClause}`;
}
