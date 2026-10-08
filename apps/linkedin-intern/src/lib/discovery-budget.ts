/**
 * Daily extract-budget helpers shared by the discovery scheduler.
 *
 * The instance has ONE daily extract cap (LINKEDIN_DAILY_EXTRACT_CAP) counted
 * across all lanes. Left unmanaged, the high-volume keyword + profile SEARCH
 * lanes burn the whole budget and starve the always-on WATCH lane (the
 * operator's hand-picked connections). To prevent that, the top band of the cap
 * is RESERVED for the watch lane: once the day's running total reaches
 * (cap − reserve) the search lanes stop, but the watch lane keeps drawing to the
 * full cap.
 */

/**
 * The point in the daily budget past which only the watch lane may extract.
 * Below this the search lanes run; at/above it they're paused for the day.
 * Never negative, never above the cap.
 */
export function searchExtractCeiling(cap: number, reserve: number): number {
  return Math.max(0, cap - Math.max(0, reserve));
}

/**
 * True when the day's extract total has entered the reserved watchlist band, so
 * the keyword + profile SEARCH lanes should be paused for the rest of the day.
 * A reserve of 0 disables the reservation (search runs until the full cap).
 */
export function searchLanesExhausted(
  alreadyExtractedToday: number,
  cap: number,
  reserve: number,
): boolean {
  if (reserve <= 0) return false;
  return alreadyExtractedToday >= searchExtractCeiling(cap, reserve);
}
