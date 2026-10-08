// Opening-move variety for the reply drafters (Lyra on LinkedIn, Vega on X).
//
// The register set (lib/register.ts) varies TONE and LENGTH. This varies the
// STRUCTURE — specifically how the comment OPENS — because the strongest "every
// reply looks the same" tell is the opening move: the model reaches for the same
// "love this / this is huge / so true" lead-in every time. Sampling temperature
// is already maxed (1.0), so structural variety has to be injected, not dialled.
//
// Per lead we pick ONE opening move by weighted random choice and inject it as a
// directive into the comment-drafting prompt. It shapes only the OPENING; the
// register still governs length/energy and every NEVER-DO rule stays intact.
// Gated behind NOELLE_DRAFTER_VARIETY (same flag as the register) — when off, no
// opening-move block is injected and drafts are unchanged. Replies only; the DM
// is never touched. Mirrors the shape of register.ts on purpose.
//
// Shared via @noelle/runtime so both interns rotate ONE set of moves. The only
// platform difference is what a reply is called, so renderOpeningMoveBlock takes
// the noun as a parameter and defaults to LinkedIn's wording (Lyra's rendered
// block is byte-identical to before the move).

export interface OpeningMove {
  id: string;
  /** Weight in (0,1]; the weights across all moves sum to 1. */
  weight: number;
  /** The "OPENING MOVE" directive injected into the comment-drafting prompt. */
  directive: string;
}

// Weights sum to 1.00 exactly. No single move dominates, so openings visibly
// vary across the feed:
//   REACT .20 + DETAIL .20 + TAKE .20 + QUESTION .15 + PUSHBACK .15 + ANECDOTE .10
export const OPENING_MOVES: OpeningMove[] = [
  {
    id: "REACT",
    weight: 0.2,
    directive:
      "Open with a direct reaction to the SPECIFIC thing in the post — name what you're reacting to, not a generic 'love this' / 'so true' / 'this is huge'.",
  },
  {
    id: "DETAIL",
    weight: 0.2,
    directive:
      "Open by naming one concrete detail from the post, then say what it means FOR YOU or what it would cost, not what you think OF it. Never make the detail the subject of a verdict ('the X line is the part that…', 'X is doing a lot of work'), because that is the house skeleton and this move is where much of it came from. Lead with the detail, land on your own side of it.",
  },
  {
    id: "TAKE",
    weight: 0.2,
    directive:
      "Open with your own opinion stated flat (no 'I think', no hedging), then connect it to the post.",
  },
  {
    id: "QUESTION",
    weight: 0.15,
    directive:
      "Open with a genuine, specific question the post raises for you — one a real peer would actually ask, not a rhetorical one.",
  },
  {
    id: "PUSHBACK",
    weight: 0.15,
    directive:
      "Open by gently complicating or disagreeing with ONE point in the post — respectfully and with a real reason. Do not manufacture agreement you don't have.",
  },
  {
    id: "ANECDOTE",
    weight: 0.1,
    directive:
      "Open with a quick first-person observation from your own work that the post genuinely reminds you of. ONLY if it's true — never invent an experience to fit the post.",
  },
];

/**
 * Pick ONE opening move for a lead by weighted random choice. `rng` is injectable
 * so tests are deterministic (defaults to Math.random in the worker). The moves
 * are walked in OPENING_MOVES order and the first whose cumulative weight exceeds
 * `r` wins. A pathological r >= sum (or NaN) falls back to the last move.
 */
export function pickOpeningMove(
  rng: () => number = Math.random,
  moves: readonly OpeningMove[] = OPENING_MOVES,
): OpeningMove {
  const pool = moves.length > 0 ? moves : OPENING_MOVES;
  const total = pool.reduce((acc, m) => acc + m.weight, 0);
  const r = rng() * total;
  let cumulative = 0;
  for (const move of pool) {
    cumulative += move.weight;
    if (r < cumulative) return move;
  }
  return pool[pool.length - 1]!;
}

/**
 * The opening moves Vega may use on X. ANECDOTE is dropped: it prompts for "a
 * first-person observation from your own work", and SYSTEM_X_BASE's RECYCLED
 * PROPS section exists precisely because Vega kept reaching for the same
 * invented personal props (the late-night hour, the study prop) until they were
 * banned by shape. Asking for an anecdote on ~10% of replies re-opens that
 * failure mode. The remaining five renormalize (pickOpeningMove scales by the
 * pool total), and LinkedIn keeps all six.
 */
export const X_OPENING_MOVES: readonly OpeningMove[] = OPENING_MOVES.filter(
  (m) => m.id !== "ANECDOTE",
);

/**
 * Render the "OPENING MOVE" block injected into the comment-drafting prompt.
 * Kept here (next to the moves) so the worker and tests share one renderer.
 */
export function renderOpeningMoveBlock(move: OpeningMove, noun = "comment"): string {
  return [
    `OPENING MOVE FOR THIS REPLY (varies only how the ${noun} STARTS, applies to the ${noun}(s), NOT the DM)`,
    move.directive,
    "This shapes only the opening. If the assigned register is ultra-short, keep the opening within that length. Keep every other rule (no em dashes, no corporate verbs, no reframe/negative-parallelism, no echoing the post, English only, the emoji allowlist) fully intact. This never applies to the DM.",
  ].join("\n");
}
