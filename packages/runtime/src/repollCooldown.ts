/**
 * Per-key re-poll cooldown for the WATCH/WATCHLIST lanes.
 *
 * Consolidated from three byte-for-byte-equivalent copies:
 *   apps/linkedin-intern/src/lib/repoll-cooldown.ts  (Lyra — key: person publicId)
 *   apps/x-intern/src/lib/repoll-cooldown.ts         (Vega — key: handle)
 *   apps/reddit-intern/src/lib/repoll-cooldown.ts    (Orion — key: lowercased subreddit)
 * The three differed ONLY in their header prose and in the parameter *name*
 * (`publicId` in Lyra/Vega, `key` in Orion). The gate body — the actual cooldown
 * policy — was identical in all three, so this is one policy over three id types,
 * not three policies. `key` wins because the three platforms identify a poll
 * target differently; it is a positional parameter, so no call site changed.
 *
 * Why the gate exists: the daily extract cap counts newly-inserted LEADS, not
 * Apify actor calls — so before this gate every watched target was re-fetched on
 * every discovery tick (~96×/day/target at Lyra+Orion's 15-min tick, up to
 * ~288×/day/handle at Vega's 5-min tick) even though almost every poll returned
 * nothing new. Zero-result runs still burn Apify credit (and are not even metered
 * to llm_calls), which is what ground the free-token pool down; on X they also
 * burn rate-bucket tokens the keyword lane needs. The gate makes a target
 * poll-able at most once per cooldown window.
 *
 * Per-platform behaviour stays with the caller, not in here:
 *   - the window comes in as `cooldownMs` (LINKEDIN_WATCHLIST_REPOLL_HOURS
 *     defaults 4, X_WATCHLIST_REPOLL_HOURS 2, REDDIT_WATCHLIST_REPOLL_HOURS 0);
 *   - `cooldownMs <= 0` disables the gate entirely (Orion's default = off);
 *   - WHEN to consult the gate is the caller's call (Vega only gates the
 *     watch-lane-only case, so a handle that is also a targeting handle stays
 *     ungated while the keyword lane is on).
 *
 * State is in-memory (per worker process): a pm2 restart just means one extra
 * full sweep, which is the pre-gate behaviour for a single tick. The watchlist is
 * small (tens of targets), so the map never needs pruning.
 */
export interface RepollGate {
  /** True when the key may be polled (never attempted, or the window elapsed). */
  due(key: string): boolean;
  /** Record a poll ATTEMPT (call when the fetch fires, success or not). */
  stamp(key: string): void;
}

export function createRepollGate(cooldownMs: number, now: () => number = Date.now): RepollGate {
  const lastAttempt = new Map<string, number>();
  return {
    due(key) {
      if (cooldownMs <= 0) return true;
      const t = lastAttempt.get(key);
      return t == null || now() - t >= cooldownMs;
    },
    stamp(key) {
      lastAttempt.set(key, now());
    },
  };
}
