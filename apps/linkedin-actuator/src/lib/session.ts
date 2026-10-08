import { makeRng, type Rng } from "./rng.js";

/**
 * A stable per-session "persona" that drives human-arc behavior:
 * personal tempo, reading speed, hand tremor, autocorrelation,
 * click bias side, and whether this is a read-heavy session.
 */
export interface SessionPersona {
  /** Median gap in ms between write actions (personal tempo). */
  baseGapMs: number;
  /** Reading speed in words per minute. */
  wpm: number;
  /** Hand tremor amplitude (cursor jitter scale). */
  tremorAmp: number;
  /** AR(1) autocorrelation for gap inter-action timing. */
  rho: number;
  /** Dominant click side: +1 = right-bias, -1 = left-bias. */
  clickBiasSide: 1 | -1;
  /** Read-heavy sessions do fewer writes and more scroll-read (≈40% true). */
  readHeavy: boolean;
}

/**
 * Draw a stable persona for this session from the seeded RNG.
 *
 * The spreads below are deliberately wide so two sessions differ a lot
 * (session-to-session variance is the strongest anti-fingerprint lever).
 * Widening is asymmetric: central tendency stays the same or slightly
 * slower, and lower timing bounds are never loosened.
 *
 * - baseGapMs: logNormal with mu_log = ln(230000) ≈ 12.346 and
 *   sigma_log = 0.40 so the median ≈ 230 s (slightly slower than before)
 *   with a much longer upper tail. The arithmetic mean rises with the
 *   wider sigma, so the average session is slower, never faster.
 * - wpm: normal(238, 82) clamped to [115, 400]. Floor lowered so slow,
 *   long-dwell readers appear; ceiling unchanged so no faster reading.
 * - tremorAmp: normal(0.4, 0.28) clamped to [0.12, 1.6]. Wider hand-jitter
 *   spread; the slightly higher floor keeps every session visibly human.
 * - rho: normal(0.4, 0.16) clamped to [0.15, 0.78]. Wider streaky-vs-steady
 *   rhythm; autocorrelation does not change the mean inter-action gap.
 * - clickBiasSide: ±1 with equal probability.
 * - readHeavy: true ≈ 40% of the time.
 */
export function makeSessionPersona(seed: number): SessionPersona {
  const rng = makeRng(seed);

  // logNormal: mu_log = ln(230000), sigma_log = 0.40
  // Median = exp(mu_log) = 230000; the wider sigma stretches the upper
  // tail and lifts the arithmetic mean (slower on average, never faster).
  const muLog = Math.log(230000);
  const sigmaLog = 0.4;
  const baseGapMs = rng.logNormal(muLog, sigmaLog);

  const wpm = Math.min(400, Math.max(115, rng.normal(238, 82)));

  const tremorAmp = Math.min(1.6, Math.max(0.12, rng.normal(0.4, 0.28)));

  const rho = Math.min(0.78, Math.max(0.15, rng.normal(0.4, 0.16)));

  const clickBiasSide: 1 | -1 = rng.next() < 0.5 ? 1 : -1;

  // ≈40% true: sample uniform in [0,1) and check < 0.4
  const readHeavy = rng.next() < 0.4;

  return { baseGapMs, wpm, tremorAmp, rho, clickBiasSide, readHeavy };
}

/**
 * Warm-up gap multiplier: ramps linearly from 1.4 at t=0 down to 1.0
 * at 4 minutes (240000 ms), then holds at 1.0.
 *
 * @param elapsedMs  Milliseconds since session start.
 * @returns          A multiplier ≥ 1.0 to scale the inter-action gap.
 */
export function warmupScale(elapsedMs: number): number {
  const WARMUP_DURATION_MS = 240000; // 4 minutes
  const MAX_SCALE = 1.4;
  const MIN_SCALE = 1.0;
  if (elapsedMs >= WARMUP_DURATION_MS) return MIN_SCALE;
  const progress = elapsedMs / WARMUP_DURATION_MS; // 0 → 1
  return MAX_SCALE - (MAX_SCALE - MIN_SCALE) * progress;
}

/**
 * Draw the write-suppression window for this session start.
 * Writes are scroll/read-only for the first `warmupSuppressWritesMs` ms.
 *
 * Drawn from normal(120000, 55000) clamped to [30000, 300000]. The median
 * still lands near 2 min, but the wider sigma and higher ceiling let a
 * session occasionally read-only for up to 5 min before its first write
 * (a longer warm-up is safer, never faster). The 30 s floor is unchanged.
 *
 * @param rng  Seeded Rng instance.
 * @returns    Milliseconds to suppress write actions.
 */
export function warmupSuppressWritesMs(rng: Rng): number {
  return Math.min(300000, Math.max(30000, rng.normal(120000, 55000)));
}

/**
 * Engagement decay: gentle within-session rate decay with floor 0.4.
 *
 * decay(t) = max(0.4, exp(-t / T35))   where T35 = 35 min
 *
 * At t=0:  1.0
 * At t=35m: exp(-1) ≈ 0.368 → floored to 0.4
 * As t→∞:  0.4
 *
 * @param elapsedMs  Milliseconds since session start.
 * @returns          A rate multiplier in [0.4, 1.0].
 */
export function engagementDecay(elapsedMs: number): number {
  const T35 = 35 * 60000; // 35 minutes in ms
  return Math.max(0.4, Math.exp(-elapsedMs / T35));
}

/**
 * Determine if a micro-break is due and how long it should be.
 *
 * A break becomes due when `activitySinceBreakMs` exceeds a gamma-drawn
 * threshold: gamma(k=1.5, theta=960000) → mean ≈ 24 min between breaks
 * (same mean as before, but the lower shape parameter widens the spread
 * so break cadence varies more from break to break and session to session).
 *
 * When due, the break length is drawn from logNormal with median 90 s
 * (90000 ms), sigma_log=0.75, clamped to [20000, 600000]. The median is
 * unchanged; the wider sigma and higher ceiling add occasional long
 * "stepped away" distraction breaks (extra pauses are safer, never faster).
 *
 * NOTE: The gamma threshold is drawn from `rng` fresh each call, so this
 * function must receive the same deterministic Rng to be reproducible.
 * Callers that want a stable threshold per-break should cache the
 * threshold outside this function.
 *
 * @param activitySinceBreakMs  Ms of activity since the last break.
 * @param rng                   Seeded Rng instance.
 * @returns                     `{ due: boolean; breakMs: number }`.
 *                              breakMs is 0 when not due.
 */
export function microBreakDue(
  activitySinceBreakMs: number,
  rng: Rng
): { due: boolean; breakMs: number } {
  // Draw the threshold for this check
  const threshold = rng.gamma(1.5, 960000); // mean = 1.5 * 960000 = 24 min, wider spread

  if (activitySinceBreakMs < threshold) {
    return { due: false, breakMs: 0 };
  }

  // Break is due — draw its duration
  const muLog = Math.log(90000); // median = 90 s
  const sigmaLog = 0.75;
  const breakMs = Math.min(
    600000,
    Math.max(20000, rng.logNormal(muLog, sigmaLog))
  );
  return { due: true, breakMs };
}
