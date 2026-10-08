/**
 * Daily extract-budget helpers for the X discovery scheduler. Ported from Lyra.
 *
 * The instance has ONE daily extract cap (X_DAILY_EXTRACT_CAP) counted across
 * all lanes. Left unmanaged, the high-volume KEYWORD lane burns the whole budget
 * and starves the always-on WATCH lane — the operator's hand-picked accounts,
 * which are the ones they actually care about. So the top band of the cap is
 * RESERVED for the watch lane: once the day's running total reaches
 * (cap − reserve) the keyword lane stops, but the watch lane keeps drawing to
 * the full cap.
 *
 * Pure so the arithmetic is unit-testable without a DB.
 */

/**
 * The point in the daily budget past which only the watch lane may extract.
 * Below this the keyword lane runs; at/above it it is paused for the day.
 * Never negative, never above the cap.
 */
export function searchExtractCeiling(cap: number, reserve: number): number {
  return Math.max(0, cap - Math.max(0, reserve));
}

/**
 * True when the day's extract total has entered the reserved watchlist band, so
 * the keyword lane should be paused for the rest of the day. A reserve of 0
 * disables the reservation (keyword runs until the full cap). An unlimited
 * cap has no reserved band.
 */
export function searchLanesExhausted(
  alreadyExtractedToday: number,
  cap: number,
  reserve: number,
): boolean {
  if (cap <= 0 || reserve <= 0) return false;
  return alreadyExtractedToday >= searchExtractCeiling(cap, reserve);
}

/** True when the day's cap is spent entirely — no lane may extract. */
export function dailyCapReached(alreadyExtractedToday: number, cap: number): boolean {
  if (cap <= 0) return false; // 0 = unlimited
  return alreadyExtractedToday >= cap;
}
