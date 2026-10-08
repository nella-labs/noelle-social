import type { Rng } from "./rng.js";

export interface DwellHints {
  hasMedia?: boolean;
  isWatchlist?: boolean;
}

/**
 * Sigmoid function: 1 / (1 + exp(-x))
 */
function sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-x));
}

/**
 * Compute how long (ms) a human would spend reading a post of the given
 * word count. Draws from a skim-vs-engage mixture calibrated to Brysbaert
 * 238 wpm with Weibull-flavored right-skew (spec §3b).
 *
 * @param rng        Seeded RNG (pure, no Math.random).
 * @param wordCount  Visible word count of the post.
 * @param hints      Optional per-post context (media, watchlist author).
 * @param sessionWpm Reader's personal WPM for this session; clamped [130, 400].
 * @returns          Positive integer milliseconds.
 */
export function readingDwellMs(
  rng: Rng,
  wordCount: number,
  hints: DwellHints,
  sessionWpm: number
): number {
  // Per-post WPM noise ±14% around the session baseline, clamped [130, 400].
  // Widened from ±10%: real reading speed wobbles more post-to-post than that, and
  // this is the WITHIN-session jitter — distinct from the session persona's own wpm
  // spread in session.ts, so it is not a double-application. Because dwell ∝ 1/wpm,
  // a wider spread nudges the mean read slightly LONGER (Jensen), never shorter.
  const wpm = Math.min(400, Math.max(130, rng.normal(sessionWpm, sessionWpm * 0.14)));

  const tRead = (wordCount / wpm) * 60_000;

  // Skim-vs-engage: p=0.55 skim, p=0.45 engage (split unchanged — the mean read
  // stays put). Each mode now draws a lower-shape / higher-scale gamma with the
  // SAME mean multiplier but a wider, more right-skewed spread, so repeated reads
  // scatter instead of clustering into a fingerprintable band:
  //   SKIM   gamma(2, 0.25) → gamma(1.5, 1/3): mean 0.5 kept, sd 0.35 → 0.41
  //   ENGAGE gamma(3, 0.5)  → gamma(2, 0.75):  mean 1.5 kept, sd 0.87 → 1.06
  const isSkim = rng.next() < 0.55;
  const multiplier = isSkim ? rng.gamma(1.5, 1 / 3) : rng.gamma(2, 0.75);
  let dwell = tRead * multiplier;

  // Occasional "re-read / distraction" tail: ~8% of reads the eye lingers, the
  // mind wanders, or the reader scrolls back up. Multiply by 1 + gamma(1.6, 0.6)
  // (a heavy right tail that only ever LENGTHENS a read, never shortens it). This
  // is the one deliberate shift to the central tendency — ~+8% slower on average,
  // squarely in the safe direction, never faster or burstier.
  if (rng.next() < 0.08) {
    dwell *= 1 + rng.gamma(1.6, 0.6);
  }

  // Floor 600 ms (unchanged — never lowered). Global ceiling raised 45s → 75s so
  // the engaged / distracted tail can reach a plausible deep read instead of
  // piling up on a hard wall (a wall is itself a low-variance, detectable tell).
  dwell = Math.max(600, Math.min(75_000, dwell));

  // Media bonus: extra time spent on an attached image/video. Widened from
  // normal(1500, 600) to logNormal(median 1400, σ_log 0.55) → mean ≈ 1630 ms with a
  // natural right tail (a quick glance ~700 ms, occasionally studying a chart ~4 s).
  // Always positive, so it still strictly raises the mean whenever media is present,
  // and it scatters wider than the old clamped normal.
  if (hints.hasMedia) {
    dwell += rng.logNormal(Math.log(1_400), 0.55);
  }

  return Math.max(1, Math.round(dwell));
}

/**
 * Decide whether to stop and read this post (true) or scroll past (false).
 * P(stop) = sigmoid(-1.2 + 0.012·wordCount + 0.6·hasMedia + 0.4·isWatchlist + ε),
 * where ε ~ normal(0, 0.6) is a per-call attention/mood jitter.
 *
 * Roughly: ~30-word post → P≈0.30; 200-word → P≈0.78; media/watchlist pushes
 * higher — but ε makes the effective probability wobble every call instead of
 * being a fixed, replayable function of word count.
 */
export function decideStop(
  rng: Rng,
  wordCount: number,
  hints: DwellHints
): boolean {
  const baseLogit =
    -1.2 +
    0.012 * wordCount +
    (hints.hasMedia ? 0.6 : 0) +
    (hints.isWatchlist ? 0.4 : 0);
  // Attention/mood jitter (σ = 0.6 in logit space). Without it, every N-word post
  // stops with an identical probability every session — a low-variance curve a
  // detector can fit and replay-check. The jitter smears that curve so the
  // stop/glance decision scatters. It is symmetric (mean 0): on a feed of mostly
  // short posts (P < 0.5) it nudges the stop-rate slightly UP — more reading, never
  // a faster scroll — and because each context shift (word count, +0.6 media, +0.4
  // watchlist) dominates a ±0.6 wobble, it cannot invert the monotone orderings.
  const logit = baseLogit + rng.normal(0, 0.6);
  const p = sigmoid(logit);
  return rng.next() < p;
}

/**
 * Dwell time when scrolling past a post without stopping to read — just a quick
 * glance. Widened from normal(450, 150) clamped [150, 1500] to
 * logNormal(median 450, σ_log 0.45) clamped [150, 2500]: the median stays quick
 * (≈450 ms, = the old mean) while the right tail is heavier and the ceiling is
 * raised, so an occasional "something caught my eye" pause (~1–2 s) reads as human.
 * Floor held at 150 ms (never lowered); the mean rises slightly (≈500 ms), never falls.
 */
export function glanceMs(rng: Rng): number {
  const raw = rng.logNormal(Math.log(450), 0.45);
  return Math.round(Math.min(2500, Math.max(150, raw)));
}
