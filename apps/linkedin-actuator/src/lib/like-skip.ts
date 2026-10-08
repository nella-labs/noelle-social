// Occasionally NOT liking a post you just replied to.
//
// The actuator reacts to every post it comments on ("a human likes what they
// engage with" — see likeCurrentPost). But a human doesn't ALWAYS, and a
// 100%-consistent reply→like pairing is itself a detectable tell. So skip the
// coupled reaction on a small, DRIFTING fraction of replies: the skip rate
// starts at BASE and is re-rolled uniformly in [MIN, MAX] every REROLL_EVERY
// reply-reactions, so the rate isn't a static signature either.

export const LIKE_SKIP_BASE = 0.02; // starting skip rate (2%)
export const LIKE_SKIP_MIN = 0.01; // drift floor (1%)
export const LIKE_SKIP_MAX = 0.05; // drift ceiling (5%)
export const LIKE_SKIP_REROLL_EVERY = 123; // re-roll the rate every N reply-reactions

export interface LikeSkipState {
  /** Current skip probability, in [MIN, MAX]. */
  prob: number;
  /** Reply-reaction opportunities seen this run — drives the re-roll cadence. */
  count: number;
}

/**
 * Advance the drift counter by one reply-reaction and decide whether to SKIP
 * this post's coupled like. `rand` returns a float in [0, 1). Pure and
 * deterministic given `rand`, so it unit-tests without a clock. Returns the
 * decision plus the next state to persist on the RunState.
 *
 * The rate is re-rolled every REROLL_EVERY opportunities (123, 246, …) and held
 * between re-rolls; a fresh run (prev undefined) starts at LIKE_SKIP_BASE.
 */
export function rollLikeSkip(
  prev: LikeSkipState | undefined,
  rand: () => number,
): { skip: boolean; next: LikeSkipState } {
  let prob = prev?.prob ?? LIKE_SKIP_BASE;
  const count = (prev?.count ?? 0) + 1;
  if (count % LIKE_SKIP_REROLL_EVERY === 0) {
    prob = LIKE_SKIP_MIN + rand() * (LIKE_SKIP_MAX - LIKE_SKIP_MIN);
  }
  const skip = rand() < prob;
  return { skip, next: { prob, count } };
}
