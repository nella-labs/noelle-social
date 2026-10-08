import { makeRng, type Rng } from "./rng.js";
import { isWriteCurfew } from "./curfew.js";
import type { ActionKind, PlannedAction, RunParams } from "./types.js";
import { REDDIT_DEFAULTS } from "./types.js";

export interface Caps { likes: number; comments: number; dms: number; }
export interface ClampNote { kind: ActionKind; requested: number; allowed: number; }

interface PlanOpts {
  params: RunParams;
  approvedDms: number;
  caps: Caps;
  startMs: number;
  deepNightTaper: boolean;
  // Hard ceiling on write actions (comment + dm) per rolling hour. Omitted or 0
  // disables the pass (keeps existing callers/tests unchanged).
  maxWritesPerHour?: number;
  rng: Rng;
}

const HOUR = 3600_000;
const MINUTE = 60_000;

// ── Drain mode ──────────────────────────────────────────────────────────────
// "Post ALL approved replies a gap apart, filling each gap with ambient browsing."
// A distinct schedule from planTimeline's window-spread pacing: one comment slot
// per approved reply, spaced by drainGapMs (4 min + 0–900s on Reddit). The normal
// tick engine executes it unchanged. Ported from the LinkedIn actuator, but the
// per-gap like slots are INERT on Reddit (likesPerGap fed 0 — voting only ever
// happens via the idle-upvote path, never as a scheduled drain slot).
export interface DrainOpts {
  approvedComments: number;
  startMs: number;
  rng: Rng;
  likesPerGapMin?: number; // default 4 (INERT on Reddit — always fed 0, no voting via slots)
  likesPerGapMax?: number; // default 8 (INERT on Reddit — always fed 0)
  // INERT: the inter-reply gap is drawn by drainGapMs as a quick/normal/cooldown
  // timing archetype inside [base, base+rand]; there is no short/normal band to
  // bias. Retained only so existing callers that still pass it keep type-checking.
  shortBandProb?: number;
  // ── Session archetype (per-session "drain temperament") — TIMING-ONLY ───────
  // Drawn once at startDrain (pickDrainArchetype), persisted on RunState, and
  // passed to BOTH plan call sites so every extension round shares the mood.
  // Absent (the direct unit-test path) ⇒ today's exact defaults, byte-identical.
  // Reddit's drain is REPLY-ONLY, so the archetype carries ONLY timing knobs — the
  // per-band gap mix + one optional long break — never a like/upvote knob (there
  // are no like slots to shape).
  bandWeights?: number[]; // per-session weight vector over [quick, normal, cooldown]
  longBreakMs?: number;   // when >0, one inter-reply gap becomes a quiet ~this-long "stepped away" pause
}

// Inter-reply gap for the Reddit drain. Reddit posts no like slots, so the only
// per-gap variety a reply-only drain can carry is the gap TIMING itself. This
// used to be a flat uniform [base, base+rand] — but a perfectly uniform band has
// hard, readable edges (an analyst reads the exact 4-min and 19-min bounds and
// the even density straight off a session). So each gap now draws a TIMING
// ARCHETYPE instead:
//   quick     near the floor — an occasional quick reply-after-reply (~4-7.6 min)
//   normal    the middle band, the mode (~7.6-13.3 min)
//   cooldown  a long "stepped away" pause between replies (~13.3-19 min)
// The weights are deliberately UPPER-TAIL-HEAVY (cooldown > quick): this breaks
// the flat-uniform fingerprint while keeping the MEAN gap equal-or-SLOWER than
// the old uniform (~11.9 min vs 11.5 min) — reply velocity never rises. That
// direction is mandatory because drain bypasses BOTH the runtime replySpacingOk
// floor and maxWritesPerHour, so the planned gap is the SOLE spacing backstop; a
// quick-heavy mixture (mass shifted toward the floor) would be a real velocity
// regression even though no single gap dips below 240s. Every band stays strictly
// inside [base, base+rand], so the 240s floor and the 19-min ceiling are
// untouched. Same base+rand envelope as the scheduled-mode min-spacing floor
// (REDDIT_DEFAULTS.minReplySpacingMs === replyBaseGapMs), so drain and scheduled
// pacing still agree.
// The default per-band mixture — quick 0.20 / normal 0.38 / cooldown 0.42.
// Upper-tail-heavy so the mean is equal-or-slower than the legacy flat uniform
// (mean 690_000ms), never faster. A per-session archetype (pickDrainArchetype)
// may pass its OWN vector, but only ever an equal-or-slower one (see the mean
// invariant on DRAIN_ARCHETYPES). Absent ⇒ this exact default, so the direct
// (no-archetype) drain path stays byte-identical.
const DEFAULT_DRAIN_BANDS = [0.2, 0.38, 0.42]; // quick / normal / cooldown

export function drainGapMs(rng: Rng, bandWeights: number[] = DEFAULT_DRAIN_BANDS): number {
  const base = REDDIT_DEFAULTS.replyBaseGapMs; // 240_000 — hard floor
  const rand = REDDIT_DEFAULTS.replyRandGapMs; // 900_000 — top of the tail
  const band = rng.pickWeighted(bandWeights); // quick / normal / cooldown
  if (band === 0) return base + rng.int(0, Math.round(rand * 0.24));
  if (band === 1) return base + rng.int(Math.round(rand * 0.24), Math.round(rand * 0.62));
  return base + rng.int(Math.round(rand * 0.62), rand);
}

// ── Per-session drain temperament (TIMING-ONLY) ──────────────────────────────
// Per-gap band draws break the "every gap looks identical" fingerprint; this
// breaks the "every SESSION looks identical" one. Each drain draws a named
// archetype once, then jitters it, so no two sessions share the same band mix or
// break-proneness. Reddit's drain is REPLY-ONLY (no like slots), so — unlike the
// LinkedIn archetype — this carries ONLY timing: a weight vector over the SAME
// three drainGapMs bands [quick, normal, cooldown], plus one optional long break.
// Safe by construction: every archetype's band mixture keeps a mean gap ≥ the
// current default (~11.9 min) — the jitter is MEAN-MONOTONE (it only ever moves
// weight from a faster band toward a slower one), the bands themselves are
// unchanged so every gap stays inside [240s, 1140s], and the long break only ADDS
// time (a top-of-envelope "stepped away" pause). So every archetype is
// same-or-slower than today — reply velocity can never rise, which is mandatory
// because drain bypasses BOTH replySpacingOk and maxWritesPerHour (the planned
// gap is the sole spacing backstop).
export interface DrainArchetype {
  bandWeights: number[]; // over [quick, normal, cooldown]; mean gap ≥ the default mix
  longBreakMs: number;   // 0 = this session takes no long break
}

interface ArchetypeSpec {
  weight: number;                      // how often this temperament is drawn
  bands: [number, number, number];     // base [quick, normal, cooldown] weights (mean ≥ default)
  longBreak: [number, number] | null;  // break-duration band (top of the envelope), or null for none
}

// Every spec's base mixture has a mean gap ≥ the default mix's (~714_840ms /
// ~11.9 min): mass is only ever shifted from the quick band toward normal/cooldown
// relative to the default, never the reverse. Break bands sit at the TOP of the
// [240s, 1140s] envelope, so a break is always longer than the archetype's own
// mean gap — it can only raise the session mean, never lower it.
const DRAIN_ARCHETYPES: ArchetypeSpec[] = [
  // steady — the default mix, normal tempo, no breaks (the "equal" baseline).
  { weight: 0.30, bands: [0.20, 0.38, 0.42], longBreak: null },
  // measured — a touch more cooldown; slightly slower, no breaks.
  { weight: 0.22, bands: [0.16, 0.40, 0.44], longBreak: null },
  // deliberate — cooldown-leaning, slower, no breaks.
  { weight: 0.18, bands: [0.14, 0.36, 0.50], longBreak: null },
  // lurker — mostly long "stepped away" gaps; slowest, and takes a long break.
  { weight: 0.16, bands: [0.10, 0.30, 0.60], longBreak: [960_000, 1_140_000] },
  // bursty-then-quiet — cooldown-heavy with a mid-session long break.
  { weight: 0.14, bands: [0.12, 0.34, 0.54], longBreak: [900_000, 1_080_000] },
];

export function pickDrainArchetype(rng: Rng): DrainArchetype {
  const spec = DRAIN_ARCHETYPES[rng.pickWeighted(DRAIN_ARCHETYPES.map((s) => s.weight))]!;
  // Mean-monotone jitter: only ever shift weight from a FASTER band toward a
  // slower one, so a jittered session's mean gap can never drop below the spec's
  // (already ≥-default) base mean. quick sheds up to 40% of its mass into normal;
  // normal sheds up to 30% into cooldown. The bands are unchanged (envelope
  // intact) and each keeps a positive floor, so every band stays reachable.
  let [q, n, c] = spec.bands;
  const qToSlow = rng.float(0, q * 0.4);
  const nToSlow = rng.float(0, n * 0.3);
  q -= qToSlow;
  n += qToSlow - nToSlow;
  c += nToSlow;
  const longBreakMs = spec.longBreak ? Math.round(rng.float(spec.longBreak[0], spec.longBreak[1])) : 0;
  return { bandWeights: [q, n, c], longBreakMs };
}

export function planDrainTimeline(o: DrainOpts): PlannedAction[] {
  const lMin = o.likesPerGapMin ?? 4;
  const lMax = o.likesPerGapMax ?? 8;
  const bandWeights = o.bandWeights ?? DEFAULT_DRAIN_BANDS;
  // Session long break: when the archetype enables it, ONE inter-reply gap becomes
  // a quiet "stepped away" pause of ~longBreakMs (no like slots inside it → quiet
  // per inQuietDrainGap, so idle-upvotes stay out with no extra wiring). The choice
  // rides a SEPARATE plan-derived rng so the main gap stream is untouched, and it is
  // only consulted when longBreakMs is present — so the default (no-opts) path is
  // byte-identical. longBreakMs sits at the top of the [240s, 1140s] envelope, so
  // the break is inside the same spacing bounds and only ever ADDS time.
  const longBreakMs = o.longBreakMs ?? 0;
  let breakIdx = -1;
  if (longBreakMs > 0 && o.approvedComments >= 3) {
    const breakRng = makeRng((Math.trunc(o.startMs / 1000) ^ Math.imul(o.approvedComments, 0x9e3779b1)) >>> 0);
    // ~55% of eligible batches actually take a break, at a random reply boundary
    // (never the final slot — it has no following gap).
    if (breakRng.next() < 0.55) breakIdx = breakRng.int(0, o.approvedComments - 2);
  }
  const actions: PlannedAction[] = [];
  let t = o.startMs + o.rng.int(3_000, 9_000); // first reply lands soon, not instantly
  for (let i = 0; i < o.approvedComments; i++) {
    actions.push({ kind: "comment", atMs: t });
    // A session long break: this gap is a single quiet pause with no likes. Skips
    // the per-gap band/like draws entirely (only reached when longBreakMs is set,
    // so the default path never takes this branch).
    if (i === breakIdx) {
      t += longBreakMs;
      continue;
    }
    const gap = drainGapMs(o.rng, bandWeights);
    // Likes scale to the gap: a very short gap has no room for a like sweep, a
    // roomy 1–2 min gap carries the usual 4–8. Offsets stay inside the gap so a
    // like never lands after the next reply. (On Reddit lMin/lMax are fed 0, so
    // this loop runs zero times — voting is idle-only, never a drain slot.)
    if (gap >= 15_000) {
      const nLikes = o.rng.int(lMin, lMax);
      const lo = Math.min(8_000, Math.floor(gap * 0.15));
      const hi = Math.max(lo + 1_000, gap - 3_000);
      for (let k = 0; k < nLikes; k++) {
        actions.push({ kind: "like", atMs: t + o.rng.int(lo, hi) });
      }
    }
    t += gap;
  }
  return actions;
}

// The inter-reply gap width above which the drawn gap is a COOLDOWN band — the
// "stepped away between replies" pause the timing archetype deliberately left
// long. = replyBaseGapMs + 0.62·replyRandGapMs, the exact floor drainGapMs uses
// for its cooldown band, so this reads the same boundary the plan drew against.
const DRAIN_COOLDOWN_GAP_MS =
  REDDIT_DEFAULTS.replyBaseGapMs + Math.round(REDDIT_DEFAULTS.replyRandGapMs * 0.62);

// Whether `nowMs` sits inside a drain gap the plan deliberately left QUIET.
// Reddit schedules NO upvote slots (reply-only drain), so — unlike LinkedIn, where
// a quiet gap is one with zero like slots between two comments — the quiet signal
// here is the drawn TIMING band: an inter-reply gap in the COOLDOWN band
// (≥ DRAIN_COOLDOWN_GAP_MS), i.e. a long "stepped away" pause (a cooldown-band gap
// or a session long-break gap, which is longer still). Idle-UPVOTES consult this:
// firing an upvote through such a pause would erase the very quiet the archetype
// drew. Slot times are PLAN times, so the check is stable across the whole gap.
// Mirrors the LinkedIn scheduler.inQuietDrainGap shape (prev/next comment scan);
// only the quiet CRITERION differs (gap width vs like-slot presence), by design.
export function inQuietDrainGap(
  actions: readonly { kind: ActionKind; atMs: number }[],
  nowMs: number,
): boolean {
  let prevComment = -Infinity;
  let nextComment = Infinity;
  for (const a of actions) {
    if (a.kind !== "comment") continue;
    if (a.atMs <= nowMs && a.atMs > prevComment) prevComment = a.atMs;
    if (a.atMs > nowMs && a.atMs < nextComment) nextComment = a.atMs;
  }
  // Before the first reply or after the last one there is no enclosing inter-reply
  // gap to be cooling down inside — not quiet.
  if (prevComment === -Infinity || nextComment === Infinity) return false;
  return nextComment - prevComment >= DRAIN_COOLDOWN_GAP_MS;
}

// Curfew check lives in ./curfew.ts (isWriteCurfew) — the single switch every
// enforcement point shares. It is currently DISABLED (writes allowed any hour).

// Density weight for an absolute time.
// Reduces action probability for deep-night hours.
// Strengthened: 01:00–06:00 band is now 0.05 (was 0.25).
function densityWeight(_atMs: number, _taper: boolean): number {
  // Deep-night taper DISABLED (operator: post any hour). Full density every hour.
  return 1;
}

// ---------------------------------------------------------------------------
// Hard-shift a curfew-landing action to the nearest allowed hour boundary.
// Returns null if the entire window is in curfew (caller drops it).
// ---------------------------------------------------------------------------
function shiftOutOfCurfew(
  atMs: number,
  startMs: number,
  endMs: number,
): number | null {
  if (!isWriteCurfew(atMs)) return atMs;

  // Try to push forward to 06:00 of the same or next local day.
  const d = new Date(atMs);
  const h = d.getHours();

  let candidate: number;
  if (h >= 23) {
    // Past 23:00 — advance to next day 06:00
    const next6am = new Date(d);
    next6am.setDate(next6am.getDate() + 1);
    next6am.setHours(6, 0, 0, 0);
    candidate = next6am.getTime();
  } else {
    // Before 06:00 — advance to 06:00 same day
    const today6am = new Date(d);
    today6am.setHours(6, 0, 0, 0);
    candidate = today6am.getTime();
  }

  if (candidate >= startMs && candidate <= endMs) return candidate;

  // Try to pull back to 23:00 of the previous local day.
  const prev11pm = new Date(atMs);
  if (h < 6) prev11pm.setDate(prev11pm.getDate() - 1);
  prev11pm.setHours(22, 59, 0, 0); // 22:59 — just inside allowed
  const back = prev11pm.getTime();
  if (back >= startMs && back <= endMs) return back;

  return null; // whole window is in curfew — drop
}

export function planTimeline(opts: PlanOpts): { actions: PlannedAction[]; clamps: ClampNote[] } {
  const { params, approvedDms, caps, startMs, deepNightTaper, rng } = opts;
  const maxWritesPerHour = opts.maxWritesPerHour ?? 0;
  const windowMs = params.windowHours * HOUR;
  const endMs = startMs + windowMs;

  const clamps: ClampNote[] = [];
  const clamp = (kind: ActionKind, requested: number, cap: number): number => {
    if (requested > cap) { clamps.push({ kind, requested, allowed: cap }); return cap; }
    return requested;
  };

  // ── 1. ±20% per-plan volume factor ────────────────────────────────────────
  // Draw once per plan; scale requested counts before clamping to caps.
  // Floor widened DOWN to 0.72 (fewer on average = safer); the 1.2 cap unchanged.
  const volumeFactor = rng.float(0.72, 1.2);

  const rawComments = Math.round(params.targetComments * volumeFactor);
  const rawLikes    = Math.round(params.targetLikes    * volumeFactor);
  const rawDms      = Math.round(approvedDms           * volumeFactor);

  const nComments = clamp("comment", rawComments, caps.comments);
  const nLikes    = clamp("like",    rawLikes,    caps.likes);
  const nDms      = clamp("dm",      rawDms,      caps.dms);

  // ── 2. Build kind-list ─────────────────────────────────────────────────────
  const kinds: ActionKind[] = [];
  for (let i = 0; i < nComments; i++) kinds.push("comment");
  for (let i = 0; i < nLikes; i++) kinds.push("like");
  // Fisher–Yates shuffle with seeded RNG so likes/comments interleave.
  for (let i = kinds.length - 1; i > 0; i--) {
    const j = rng.int(0, i);
    [kinds[i], kinds[j]] = [kinds[j]!, kinds[i]!];
  }
  // DMs spaced widest: insert at evenly-distributed indices.
  for (let d = 0; d < nDms; d++) {
    const idx = Math.floor(((d + 1) / (nDms + 1)) * kinds.length);
    kinds.splice(idx, 0, "dm");
  }

  const total = kinds.length;
  if (total === 0) return { actions: [], clamps };

  // ── 3. Per-burst Gamma intensity ───────────────────────────────────────────
  // Burst count: ~1 burst per 36 min–2.2 h (widened from 45–90 min so session
  // shapes differ more: some days are one long sitting, some are many spurts).
  const burstCount = Math.max(1, Math.round(params.windowHours / rng.float(0.6, 2.2)));

  // Draw a Gamma(k=1.5, θ=1) weight per burst so intensity varies across bursts
  // (lower shape than the old k=2 ⇒ wider intensity spread, same mechanism).
  const burstWeights: number[] = [];
  for (let b = 0; b < burstCount; b++) {
    burstWeights.push(rng.gamma(1.5, 1));
  }
  const totalWeight = burstWeights.reduce((s, w) => s + w, 0);

  // Distribute total action count across bursts proportionally to gamma weights.
  const burstSizes: number[] = burstWeights.map((w) =>
    Math.round((w / totalWeight) * total),
  );
  // Correct rounding drift — assign remainder to heaviest burst.
  const sizeSum = burstSizes.reduce((s, v) => s + v, 0);
  const drift = total - sizeSum;
  if (drift !== 0 && burstSizes.length > 0) {
    const heaviest = burstWeights.indexOf(Math.max(...burstWeights));
    burstSizes[heaviest] = (burstSizes[heaviest] ?? 0) + drift;
  }

  // Burst start times: evenly distributed across window with random jitter.
  // A LONE burst (short windows, burstCount===1) anchors at the window OPEN, not
  // its midpoint — otherwise the first half of a short window is dead and the
  // first real action lands ~50% of the way in (the "nothing happens for 15 min"
  // bug). Multi-burst windows keep the centered spacing unchanged.
  const burstStarts: number[] = [];
  for (let b = 0; b < burstCount; b++) {
    const base = burstCount === 1
      ? startMs
      : startMs + ((b + 0.5) / burstCount) * windowMs;
    const jitter = rng.float(-windowMs / burstCount / 3, windowMs / burstCount / 3);
    burstStarts.push(Math.max(startMs, Math.min(endMs, base + jitter)));
  }

  // ── 4. AR(1) log-normal inter-action gaps within/across bursts ────────────
  // Draw rho (autocorrelation) once per plan.
  const rho = Math.min(0.6, Math.max(0.2, rng.normal(0.4, 0.1)));
  // Personal tempo: a median gap in [150s, 320s] (widened per-session spread —
  // floor UNCHANGED so the fastest sessions are no faster than before, only the
  // ceiling raised so some sessions run slower; wider band ⇒ two sessions differ
  // more). A fixed absolute gap
  // tuned for multi-hour runs OVERFLOWS a short window — every action's cursor
  // marches past the window end and piles at endMs, so a 30-min run does nothing
  // for ~15 min then clusters. So cap the median at what actually FITS the
  // window (windowMs / (total+1)), floored at a human minimum. For long windows
  // idealGap > drawn, so this is a no-op and the drawn tempo (and the whole RNG
  // stream) is unchanged; only short windows tighten.
  const MIN_HUMAN_GAP = 40_000;
  const drawnGapMs = rng.float(150_000, 320_000);
  const idealGapMs = windowMs / (total + 1);
  const medianGapMs = Math.max(MIN_HUMAN_GAP, Math.min(drawnGapMs, idealGapMs));
  // Log-space params for logNormal: median = exp(mu) → mu = log(median).
  const muLog = Math.log(medianGapMs);
  const sigmaLog = 0.8; // fixed sigma gives CV ≈ sqrt(exp(sigmaLog^2)-1) ≈ 0.9–1.4 (widened spread)

  // Occasional "stepped away" pause: at random, roughly 1 action in 5 gets an
  // extra 0–300 s (0–5 min) layered on top of its inter-action gap. Modelled as
  // an INTERMITTENT interruption (probability-gated) rather than a flat add on
  // every action — a flat add homogenises the gaps (pulls the coefficient of
  // variation below the human band and drops volume hard), whereas an occasional
  // long pause is what real humans do: it keeps the gap distribution heavy-tailed
  // and barely dents volume. Applied at plan time so it flows into every
  // downstream pass (curfew shift, taper, hourly ceiling).
  //
  // The pause draws come from a SEPARATE rng seeded from plan-deterministic
  // inputs (startMs/total/window), NOT the main stream, so the tempo/burst/volume
  // RNG sequence stays byte-for-byte unchanged — this layer only ADDS the
  // occasional pause, it never reshuffles the underlying plan. It still varies
  // run-to-run in production (startMs is a ms timestamp) and stays deterministic
  // for a fixed plan in tests.
  const EXTRA_PAUSE_PROB = 0.2;
  const PAUSE_WINDOW_FRAC = 0.06;
  const EXTRA_PAUSE_MAX_MS = Math.min(360_000, windowMs * PAUSE_WINDOW_FRAC);
  const pauseRng = makeRng(
    (Math.trunc(startMs / 1000) ^ Math.imul(total, 0x9e3779b1) ^ Math.trunc(windowMs / 1000)) >>> 0,
  );

  const actions: PlannedAction[] = [];
  // Actions that don't fit the window at a human pace are DROPPED, not squeezed
  // in — piling them at endMs is the exact all-at-once tell we avoid. Tracked so
  // the shortfall surfaces as a ClampNote instead of vanishing silently.
  const dropped: Record<ActionKind, number> = { like: 0, comment: 0, dm: 0 };

  // Walk through bursts in order, placing actions sequentially.
  let kindIdx = 0;
  let prevGap = medianGapMs; // seed for AR(1)
  let cursor = startMs;      // current time pointer
  let overflow = false;

  for (let b = 0; b < burstCount && !overflow; b++) {
    const count = burstSizes[b] ?? 0;
    // Advance cursor to burst start (if ahead of current position).
    const bs = burstStarts[b]!;
    if (bs > cursor) cursor = bs;

    for (let a = 0; a < count && kindIdx < total; a++, kindIdx++) {
      const kind = kinds[kindIdx]!;

      // AR(1) gap: gap[n] = rho*gap[n-1] + (1-rho)*base[n] + eps
      const base = rng.logNormal(muLog, sigmaLog);
      const eps = rng.normal(0, 0.13 * base);
      const gap = Math.max(8_000, rho * prevGap + (1 - rho) * base + eps);
      prevGap = gap;

      // Occasional multi-minute "distraction" pause layered on top of the AR(1)
      // tempo gap — applied only ~EXTRA_PAUSE_PROB of the time ("at random"),
      // drawn from the independent pauseRng so the main stream is untouched (see
      // above). Kept OUT of prevGap so it never compounds through the
      // autocorrelation; it's a one-off interruption, not a tempo shift. When a
      // pause lands on a tight window it pushes the tail past the end (dropped +
      // surfaced as ClampNotes below) — the intended slower/safer trade, never a
      // silent loss.
      const extraJitterMs =
        pauseRng.next() < EXTRA_PAUSE_PROB ? pauseRng.float(0, EXTRA_PAUSE_MAX_MS) : 0;

      // Skip the gap before the very first action so responsiveness clamp works.
      if (actions.length > 0) cursor += gap + extraJitterMs;

      // Overflow: this action falls past the window end. The cursor only ever
      // advances (gaps are positive, burst starts move forward), so once we're
      // past the end every remaining action is too — drop them all.
      if (cursor > endMs) { overflow = true; break; }

      let atMs = Math.max(startMs, Math.round(cursor));

      // ── 5. Overnight write-curfew hard shift ────────────────────────────
      const shifted = shiftOutOfCurfew(atMs, startMs, endMs);
      if (shifted === null) { dropped[kind]++; continue; } // whole window in curfew
      atMs = shifted;

      actions.push({ kind, atMs });
      // Update cursor to actual scheduled time so next gap is correct.
      cursor = atMs;
    }
  }

  // Anything still unplaced (overflow tail) is a window-fit shortfall.
  for (; kindIdx < total; kindIdx++) dropped[kinds[kindIdx]!]++;

  // Surface each kind's shortfall as a ClampNote so callers can log it (the
  // scheduler never silently truncates the requested volume).
  for (const k of ["comment", "like", "dm"] as ActionKind[]) {
    if (dropped[k] > 0) {
      const requested = kinds.reduce((n, kk) => (kk === k ? n + 1 : n), 0);
      clamps.push({ kind: k, requested, allowed: requested - dropped[k] });
    }
  }

  // Taper-weight pass: with deepNightTaper on, probabilistically drop actions
  // in the 01:00–06:00 band. (Curfew already hard-removes 23:00–06:00.)
  const survived = deepNightTaper
    ? actions.filter((a) => rng.next() <= densityWeight(a.atMs, true))
    : actions;

  survived.sort((a, b) => a.atMs - b.atMs);

  // ── 6. First-action-soon responsiveness ──────────────────────────────────
  // Make the FIRST action fire shortly after Run rather than potentially many
  // minutes/hours in.
  if (survived.length > 0 && survived[0]!.atMs > startMs + 8_000) {
    survived[0] = {
      kind: survived[0]!.kind,
      atMs: startMs + Math.round(rng.float(2_000, 6_000)),
    };
    survived.sort((a, b) => a.atMs - b.atMs);
  }

  // ── 7. Hourly write ceiling ───────────────────────────────────────────────
  // Cap comment+DM (write) actions to maxWritesPerHour in any rolling hour.
  // Likes are lower-risk and stay paced by the gap model. Greedy placement in
  // time order: a write may fire no earlier than the N-th previously-placed
  // write + 1h, so no 60-min window ever holds more than N writes. A write that
  // can only be placed past the window end is DROPPED (fail-safe under-actuation)
  // rather than piled at the end. Writes nudged into the curfew band are caught
  // by the runtime curfew floor in the tick loop.
  if (maxWritesPerHour > 0) {
    const writes = survived.filter((a) => a.kind !== "like").sort((a, b) => a.atMs - b.atMs);
    const placed: number[] = [];
    const dropped = new Set<PlannedAction>();
    for (const w of writes) {
      let at = w.atMs;
      if (placed.length >= maxWritesPerHour) {
        const earliest = placed[placed.length - maxWritesPerHour]! + HOUR + rng.float(30_000, 120_000);
        if (at < earliest) at = Math.round(earliest);
      }
      if (at > endMs) { dropped.add(w); continue; }
      w.atMs = at;
      placed.push(at); // monotonic (writes sorted, at only moves forward) → stays sorted
    }
    if (dropped.size > 0) {
      const kept = survived.filter((a) => !dropped.has(a));
      survived.splice(0, survived.length, ...kept);
    }
    survived.sort((a, b) => a.atMs - b.atMs);
  }

  return { actions: survived, clamps };
}
