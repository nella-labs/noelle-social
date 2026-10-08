// Multi-day warm-up ramp for a newly-automated LinkedIn identity.
//
// A fresh automation must not jump straight to full daily volume; a sudden step
// from near-zero to full activity is itself a flag. The multiplier scales the
// daily caps so the first week runs light and full volume is reached after ~4
// weeks. The automation-start timestamp is persisted once (chrome.storage) on
// the first run; from then the ramp advances with calendar time.

const DAY_MS = 86_400_000;

/** Whole days elapsed since the automation started (never negative). */
export function daysSince(startMs: number, nowMs: number): number {
  return Math.max(0, Math.floor((nowMs - startMs) / DAY_MS));
}

/**
 * Daily-cap multiplier in (0, 1]. Stepwise per week: week 0 = 0.40, +0.15 each
 * week, reaching full volume (1.0) at week 4. One step per week matches how a
 * human account would ramp rather than a smooth daily creep.
 */
export function warmupCapMultiplier(startMs: number, nowMs: number): number {
  const week = Math.floor(daysSince(startMs, nowMs) / 7);
  return Math.min(1, 0.4 + 0.15 * week);
}
