import type { Rng } from "./rng.js";

export type Point = { x: number; y: number };

// ===========================================================================
// LEGACY PLANNERS — still imported by the CDP layer. Do NOT delete yet.
// (mousePath / planScrollSteps will be removed once cdp.ts is rewired onto the
//  new mousePlan / planScrollGestures planners below.)
// ===========================================================================

// Jittered quadratic-Bézier path with a randomized control point so the cursor
// arcs toward the target like a hand, not a straight teleport. Ends exactly at `to`.
export function mousePath(from: Point, to: Point, rng: Rng): Point[] {
  const steps = rng.int(8, 18);
  const cx = (from.x + to.x) / 2 + rng.float(-60, 60);
  const cy = (from.y + to.y) / 2 + rng.float(-60, 60);
  const pts: Point[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const mt = 1 - t;
    const x = mt * mt * from.x + 2 * mt * t * cx + t * t * to.x + (i === steps ? 0 : rng.float(-1.5, 1.5));
    const y = mt * mt * from.y + 2 * mt * t * cy + t * t * to.y + (i === steps ? 0 : rng.float(-1.5, 1.5));
    pts.push({ x: Math.round(x), y: Math.round(y) });
  }
  pts[pts.length - 1] = { x: to.x, y: to.y };
  return pts;
}

export function planScrollSteps(rng: Rng, totalPx: number): number[] {
  const steps: number[] = [];
  let done = 0;
  while (done < totalPx) {
    const delta = Math.round(rng.float(120, 420));
    steps.push(delta);
    done += delta;
    if (rng.next() < 0.12) {
      const back = -Math.round(rng.float(40, 160));
      steps.push(back);
      done += back;
    }
  }
  return steps;
}

export function typingDelays(rng: Rng, length: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < length; i++) {
    // Inter-key gap as a right-skewed logNormal (median ~68 ms) instead of a flat
    // uniform(35,110): real keystroke timing IS log-normal, and the heavy right
    // tail gives per-key hesitation for free. Mean (~74 ms) ≈ the old center, so
    // the base cadence is not faster; the floor (38 ms) ≥ the old effective min.
    const base = clamp(rng.logNormal(Math.log(68), 0.42), 38, 320);
    // Two-tier "thinking" pauses layered on top: a frequent short word-boundary
    // hesitation and a rare long distraction. Net effect is slightly SLOWER and
    // much wider than the old single 6%×uniform(300,900) pause.
    let pause = 0;
    if (rng.next() < 0.1) pause += clamp(rng.logNormal(Math.log(220), 0.5), 90, 700);
    if (rng.next() < 0.02) pause += clamp(rng.logNormal(Math.log(900), 0.5), 400, 2500);
    out.push(Math.round(base + pause));
  }
  return out;
}

// ===========================================================================
// MOUSE MODEL (§3c) — sigma-lognormal velocity envelope + overshoot/correct +
// micro-tremor + variable point density + 2D-Gaussian click point.
// All pure, all seeded by an injected Rng.
// ===========================================================================

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * A 2D-Gaussian click point biased toward the element center (NOT the exact
 * geometric center). The σ FRACTION is itself drawn per click (median ~0.20,
 * spread 0.13–0.30 of the rect's width/height) so the positional scatter is
 * hierarchical — a fixed σ is its own fingerprint. Clamped inside the rect.
 * Kept sub-pixel (no rounding) so it essentially never equals the exact
 * center — humans never hit the same pixel and never hit dead-center.
 */
export function clickPoint(
  rect: { x: number; y: number; width: number; height: number },
  rng: Rng,
): Point {
  const cx = rect.x + rect.width / 2;
  const cy = rect.y + rect.height / 2;
  // σ fraction is drawn PER CLICK (median ~0.20, was a fixed 0.18) so some
  // clicks land tighter and some looser instead of every click sharing one
  // identical Gaussian. The Gaussian stays centered on the geometric center, so
  // the *mean* is still biased to the middle and the clamp keeps it in the rect.
  const sigFracX = clamp(rng.normal(0.2, 0.04), 0.13, 0.3);
  const sigFracY = clamp(rng.normal(0.2, 0.04), 0.13, 0.3);
  const sx = rng.normal(cx, rect.width * sigFracX);
  const sy = rng.normal(cy, rect.height * sigFracY);
  return {
    x: clamp(sx, rect.x, rect.x + rect.width),
    y: clamp(sy, rect.y, rect.y + rect.height),
  };
}

/**
 * 7–13 Hz sinusoidal micro-tremor added to a base coordinate. Amplitude is an
 * RMS draw `normal(0.4,0.28)` clamped [0.1,1.6] px (peak = RMS·√2 ≈ ≤2.3 px),
 * with phase and frequency taken from the rng. Median amplitude is unchanged;
 * only the spread (σ) and ceiling are widened so tremor excursions vary more.
 * A human never holds a pixel perfectly still, so this is layered onto EVERY
 * dispatched coordinate (moves + holds).
 */
export function tremor(base: Point, tMs: number, rng: Rng): Point {
  const tSec = tMs / 1000;
  const ampX = clamp(rng.normal(0.4, 0.28), 0.1, 1.6) * Math.SQRT2;
  const ampY = clamp(rng.normal(0.4, 0.28), 0.1, 1.6) * Math.SQRT2;
  const freqX = rng.float(7, 13);
  const freqY = rng.float(7, 13);
  const phaseX = rng.float(0, 2 * Math.PI);
  const phaseY = rng.float(0, 2 * Math.PI);
  return {
    x: base.x + ampX * Math.sin(2 * Math.PI * freqX * tSec + phaseX),
    y: base.y + ampY * Math.sin(2 * Math.PI * freqY * tSec + phaseY),
  };
}

/** Pre-click hover dwell: logNormal with median ~220 ms, clamped [80,650].
 *  σ_log widened 0.45→0.55 and the ceiling raised 450→650 so the occasional
 *  longer "settle before the click" hover survives instead of piling up on a
 *  hard wall. Median (central tendency) unchanged; the floor is not lowered. */
export function hoverDwellMs(rng: Rng): number {
  // median of a lognormal is exp(muLog); exp(5.394) ≈ 220.
  return clamp(rng.logNormal(Math.log(220), 0.55), 80, 650);
}

// --- sigma-lognormal velocity envelope -------------------------------------

type Impulse = { weight: number; mode: number; sigma: number };

/**
 * Lognormal "velocity" bump in normalized time τ∈(0,1], peaking at `mode`.
 * (A lognormal pdf re-centered so its peak lands at the impulse mode.)
 */
function lognormalBump(tau: number, imp: Impulse): number {
  if (tau <= 0) return 0;
  // shift so the lognormal's natural mode (at t=1) lands at `imp.mode`.
  const t = tau / imp.mode;
  if (t <= 0) return 0;
  const s = imp.sigma;
  // lognormal pdf with median 1, scaled — peak occurs near t≈exp(-s²) ≈ 1.
  const lt = Math.log(t);
  return (imp.weight / (t * s)) * Math.exp(-(lt * lt) / (2 * s * s));
}

/** Build a 2–3 impulse sigma-lognormal velocity profile (primary peak 40–55%). */
function buildEnvelope(rng: Rng): Impulse[] {
  const primaryMode = rng.float(0.4, 0.55);
  const impulses: Impulse[] = [
    // σ (velocity-bump width) spread widened so the profile shape — sharp vs
    // broad acceleration — varies far more move-to-move. Peak LOCATION (mode) is
    // untouched, so the mid-path velocity-peak invariant holds.
    { weight: 1, mode: primaryMode, sigma: clamp(rng.normal(0.5, 0.13), 0.3, 0.9) },
  ];
  // antagonist (deceleration) impulse, later and lighter
  impulses.push({
    weight: clamp(rng.normal(0.5, 0.18), 0.2, 0.9),
    mode: clamp(primaryMode + rng.float(0.18, 0.34), 0.55, 0.92),
    sigma: clamp(rng.normal(0.45, 0.13), 0.3, 0.85),
  });
  // optional 3rd (small early agonist) ~50% of the time
  if (rng.next() < 0.5) {
    impulses.push({
      weight: clamp(rng.normal(0.3, 0.14), 0.1, 0.6),
      mode: clamp(primaryMode - rng.float(0.18, 0.3), 0.08, 0.4),
      sigma: clamp(rng.normal(0.4, 0.12), 0.28, 0.7),
    });
  }
  return impulses;
}

function envelopeAt(tau: number, impulses: Impulse[]): number {
  let v = 0;
  for (const imp of impulses) v += lognormalBump(tau, imp);
  // small velocity floor so the cursor never fully stalls mid-flight
  return v + 0.04;
}

/**
 * Plan a full human mouse move from `from` to `to` against a target of size W.
 *
 * - Cubic-Bézier spatial curve, both control points jittered 40–70px off the
 *   chord and biased to ONE side (curvature ratio > 1.1).
 * - Time re-parameterized by a sigma-lognormal velocity envelope (2–3 lognormal
 *   impulses, primary peak at ~40–55% of the travel).
 * - Movement time from Fitts: MT = a + b·log2(D/W+1), a=normal(150,40),
 *   b=normal(140,30), clamped [180,900] ms.
 * - Variable point density (≈18–40 pts for a 300–600px move): points are denser
 *   near the endpoints (where velocity is low) via a cosine ease on arc-length.
 * - `sleepsMs[i]` is the (non-uniform) time to traverse segment i, = Δarc / v.
 * - `overshoot` lands `normal(7,4)` px beyond `to` along the travel direction;
 *   `correctFrom` == overshoot (the dense low-velocity correction back to the
 *   click point is dispatched by the CDP layer). `points` END at `to`.
 */
export function mousePlan(
  from: Point,
  to: Point,
  targetSize: number,
  rng: Rng,
): { points: Point[]; sleepsMs: number[]; overshoot: Point; correctFrom: Point } {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const D = Math.hypot(dx, dy) || 1;
  const W = Math.max(targetSize, 1);

  // --- Fitts movement time ---
  // Means unchanged (never faster on average); σ widened and the ceiling raised
  // 900→1200 so a fraction of moves are slow, deliberate travels (heavy tail)
  // instead of every move sharing one narrow MT band. Floor 180 unchanged.
  const a = rng.normal(150, 55);
  const b = rng.normal(140, 45);
  const MT = clamp(a + b * Math.log2(D / W + 1), 180, 1200);

  // --- point count: ~18 at 300px → ~36 at 600px, plus a per-move ±~3 jitter so
  //     the interpolation density is NOT a deterministic function of distance
  //     (a fixed D→N map is a fingerprint). Clamped [2,40]. ---
  const N = clamp(Math.round(18 + ((D - 300) / 300) * 18 + rng.normal(0, 3)), 2, 40);

  // --- spatial cubic Bézier with both control points off ONE side of chord ---
  // unit perpendicular to the chord
  const ux = dx / D;
  const uy = dy / D;
  const px = -uy; // perpendicular
  const py = ux;
  const side = rng.next() < 0.5 ? 1 : -1;
  // curvature widened 40–70 → 40–105 px (both controls independent) so the path
  // arc-height varies a lot move-to-move; the 40 px floor keeps every move
  // clearly curved (a near-straight path is the bot tell we're avoiding).
  const off1 = side * rng.float(40, 105);
  const off2 = side * rng.float(40, 105);
  // control points near 1/3 and 2/3 of the chord, pushed perpendicular
  const c1: Point = {
    x: from.x + dx * 0.33 + px * off1,
    y: from.y + dy * 0.33 + py * off1,
  };
  const c2: Point = {
    x: from.x + dx * 0.66 + px * off2,
    y: from.y + dy * 0.66 + py * off2,
  };
  const bezier = (t: number): Point => {
    const mt = 1 - t;
    const w0 = mt * mt * mt;
    const w1 = 3 * mt * mt * t;
    const w2 = 3 * mt * t * t;
    const w3 = t * t * t;
    return {
      x: w0 * from.x + w1 * c1.x + w2 * c2.x + w3 * to.x,
      y: w0 * from.y + w1 * c1.y + w2 * c2.y + w3 * to.y,
    };
  };

  // --- arc-length lookup table over the Bézier ---
  const LUT_N = 256;
  const lutT: number[] = [];
  const lutArc: number[] = [];
  let prev = bezier(0);
  lutT.push(0);
  lutArc.push(0);
  let acc = 0;
  for (let i = 1; i <= LUT_N; i++) {
    const t = i / LUT_N;
    const pt = bezier(t);
    acc += Math.hypot(pt.x - prev.x, pt.y - prev.y);
    lutT.push(t);
    lutArc.push(acc);
    prev = pt;
  }
  const totalArc = acc || D;
  // invert arc-length → t
  const tAtArc = (arc: number): number => {
    if (arc <= 0) return 0;
    if (arc >= totalArc) return 1;
    // binary search in lutArc
    let lo = 0;
    let hi = lutArc.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (lutArc[mid]! < arc) lo = mid + 1;
      else hi = mid;
    }
    const i1 = lo;
    const i0 = Math.max(0, i1 - 1);
    const a0 = lutArc[i0]!;
    const a1 = lutArc[i1]!;
    const span = a1 - a0 || 1;
    const frac = (arc - a0) / span;
    return lutT[i0]! + (lutT[i1]! - lutT[i0]!) * frac;
  };

  // --- velocity envelope (drives both timing and density) ---
  const impulses = buildEnvelope(rng);

  // --- emit N points at cosine-eased arc fractions (denser near endpoints,
  //     i.e. where velocity is low) ---
  const points: Point[] = [];
  const arcFracs: number[] = [];
  for (let i = 0; i < N; i++) {
    const u = i / (N - 1);
    // cosine ease: spacing ∝ sin(πu) → small at the ends, large in the middle,
    // so more sample points land near the (low-velocity) endpoints.
    const s = 0.5 - 0.5 * Math.cos(Math.PI * u);
    arcFracs.push(s);
    const t = tAtArc(s * totalArc);
    points.push(bezier(t));
  }
  // pin the final emitted point exactly on `to`
  points[points.length - 1] = { x: to.x, y: to.y };

  // --- non-uniform sleeps from the envelope: dt = Δarc / v(midpoint) ---
  // First compute raw dt per segment, then scale so Σdt == MT.
  const rawDt: number[] = [0];
  for (let i = 1; i < N; i++) {
    const dArc = (arcFracs[i]! - arcFracs[i - 1]!) * totalArc;
    const midTau = (arcFracs[i]! + arcFracs[i - 1]!) / 2;
    const v = envelopeAt(midTau, impulses);
    rawDt.push(dArc / v);
  }
  const rawTotal = rawDt.reduce((s, d) => s + d, 0) || 1;
  const sleepsMs = rawDt.map((d) => (d / rawTotal) * MT);

  // --- overshoot beyond `to` along the travel direction ---
  // |normal(7,4)| guarantees a positive along-travel component (always overshoots
  // in the direction of motion); the sign randomness lives in a small perpendicular
  // wobble so it doesn't undershoot back toward `from`.
  // along-travel overshoot spread widened (σ 4→5.5) and the perpendicular wobble
  // widened (0–3 → 0–6 px) so the landing scatter past the target has more
  // magnitude AND directional variety. Still always overshoots forward.
  const along = Math.abs(rng.normal(7, 5.5));
  const perpWobble = (rng.next() < 0.5 ? 1 : -1) * rng.float(0, 6);
  const overshoot: Point = {
    x: to.x + ux * along + px * perpWobble,
    y: to.y + uy * along + py * perpWobble,
  };

  return { points, sleepsMs, overshoot, correctFrom: overshoot };
}

// ===========================================================================
// SCROLL ENGINE (§3a) — momentum/inertia scroll as a sequence of gestures.
// Replaces the uniform planScrollSteps. Pure, seeded by an injected Rng.
// ===========================================================================

export type ScrollGesture = {
  kind: "flick" | "slow-drag" | "micro-nudge" | "back-scroll";
  deltas: number[];
  interDeltaMs: number[];
  postDwellMs?: number;
};

/**
 * Plan a sequence of scroll gestures whose net scroll ≈ totalPx. Each gesture is
 * drawn from a weighted mixture whose weights are themselves RE-DRAWN once per
 * call (centered on flick 0.45 / slow-drag 0.40 / micro-nudge 0.10 /
 * back-scroll 0.05, but jittered so no two scrolls share an identical gesture-
 * type balance — a fixed mixture is a session-level fingerprint).
 *
 * - FLICK: momentum. Peak v0 = logNormal median 1800 px/s clamp[800,3600]; emit
 *   a decelerating delta series (×0.95/frame at ~16.7 ms, with wider vsync jitter
 *   and the odd dropped frame) until |delta|<2px or the gesture target (logNormal
 *   median 650px clamp[200,1800]) is reached.
 * - SLOW-DRAG: deltaY = normal(90,30) clamp[40,150], 3–9 notches, inter-notch
 *   gap logNormal median 140 ms clamp[60,700] (heavy right tail = reading pauses).
 * - MICRO-NUDGE: 1–3 notches of normal(50,18) clamp[20,100].
 * - BACK-SCROLL: one negative delta normal(190,85) clamp[60,420]; it decrements
 *   the progress counter so the loop re-covers that ground (net scroll stays on
 *   totalPx instead of quietly under-shooting it).
 *
 * Every emitted deltaY is jittered ±8% and no two consecutive deltas inside a
 * gesture are ever equal. Inter-gesture transit dwell = gamma(k=2,θ=460) ms
 * clamp[80,6000], attached as the previous gesture's `postDwellMs`.
 */
export function planScrollGestures(
  rng: Rng,
  totalPx: number,
  _contentHints?: { wordCount?: number; hasMedia?: boolean }[],
): ScrollGesture[] {
  const gestures: ScrollGesture[] = [];
  let scrolled = 0;
  // safety bound so a pathological draw can't loop forever
  let guard = 0;
  const maxGestures = 400;

  // jitter a delta ±8% and force it to differ from the previous one
  const jittered = (raw: number, prevSigned: number | undefined): number => {
    let d = raw + (rng.next() * 2 - 1) * 0.08 * raw;
    // guarantee inequality with the previous signed delta
    if (prevSigned !== undefined && d === prevSigned) {
      d += d >= 0 ? 0.5 : -0.5;
    }
    return d;
  };

  // Per-plan mixture weights (drawn once so each scroll has its OWN gesture-type
  // balance instead of the identical 0.45/0.40/0.10/0.05 split every time — a
  // fixed mixture is a session-level fingerprint). Back-scroll stays tightly
  // bounded, and (being self-compensating below) can't starve forward progress.
  const wFlick = clamp(rng.normal(0.45, 0.08), 0.3, 0.6);
  const wDrag = clamp(rng.normal(0.4, 0.08), 0.25, 0.55);
  const wNudge = clamp(rng.normal(0.1, 0.04), 0.03, 0.2);
  const wBack = clamp(rng.normal(0.05, 0.02), 0.02, 0.1);

  while (scrolled < totalPx && guard++ < maxGestures) {
    const remaining = totalPx - scrolled;
    const typeIdx = rng.pickWeighted([wFlick, wDrag, wNudge, wBack]);

    const deltas: number[] = [];
    const interDeltaMs: number[] = [];
    let kind: ScrollGesture["kind"];

    if (typeIdx === 3) {
      // BACK-SCROLL — a negative delta (re-reading / thumbing back up). It now
      // DECREMENTS `scrolled`, so the loop scrolls forward again to re-cover that
      // ground: net displacement still lands on totalPx (fixes a latent
      // under-scroll) and keeps the total-scroll budget robust even as the
      // magnitude below is widened for variance.
      kind = "back-scroll";
      const raw = -clamp(rng.normal(190, 85), 60, 420);
      const d = jittered(raw, undefined);
      deltas.push(d);
      interDeltaMs.push(clamp(rng.logNormal(Math.log(150), 0.55), 60, 650));
      scrolled += d;
    } else if (typeIdx === 2) {
      // MICRO-NUDGE — 1–3 small notches
      kind = "micro-nudge";
      const notches = rng.int(1, 3);
      let prev: number | undefined;
      for (let i = 0; i < notches; i++) {
        const raw = clamp(rng.normal(50, 18), 20, 100);
        const d = jittered(raw, prev);
        deltas.push(d);
        prev = d;
        interDeltaMs.push(clamp(rng.logNormal(Math.log(140), 0.5), 60, 550));
        scrolled += d;
        if (scrolled >= totalPx) break; // stop once the destination is reached
      }
    } else if (typeIdx === 1) {
      // SLOW-DRAG — reading scroll
      kind = "slow-drag";
      const notches = rng.int(3, 9);
      let prev: number | undefined;
      for (let i = 0; i < notches; i++) {
        const raw = clamp(rng.normal(90, 30), 40, 150);
        const d = jittered(raw, prev);
        deltas.push(d);
        prev = d;
        // reading-scroll pacing: σ_log widened and the ceiling raised so an
        // occasional long "stopped to read" pause sits between notches.
        interDeltaMs.push(clamp(rng.logNormal(Math.log(140), 0.62), 60, 700));
        scrolled += d;
        if (scrolled >= totalPx) break; // stop once the destination is reached
      }
    } else {
      // FLICK — momentum with exponential decay
      kind = "flick";
      const v0 = clamp(rng.logNormal(Math.log(1800), 0.5), 800, 3600); // px/s
      // gesture target, but never carry the page far past where it's headed:
      // a human stops the flick once they've reached their destination.
      // (min with `remaining` still caps total scroll, so the ±budget holds.)
      const targetDist = Math.min(
        clamp(rng.logNormal(Math.log(650), 0.6), 200, 1800),
        remaining,
      );
      const dt = 1 / 60; // ~16.7 ms frame budget
      let v = v0;
      let gestureScrolled = 0;
      let prev: number | undefined;
      let frames = 0;
      while (frames++ < 240) {
        const rawDelta = v * dt; // px this frame
        if (rawDelta < 2) break;
        const d = jittered(rawDelta, prev);
        deltas.push(d);
        prev = d;
        // ~60fps frame budget. Real rAF-driven wheel momentum never runs FASTER
        // than the vsync cap, so the jitter is upward-only (0–3 ms slower, never
        // below the 16.7 ms budget — the low bound is NOT lowered vs baseline)
        // plus an occasional dropped frame (~2× budget). This widens inter-delta
        // spread while keeping every frame ≥ the baseline minimum.
        let frameMs = 16.7 + rng.next() * 3;
        if (rng.next() < 0.05) frameMs += 16.7;
        interDeltaMs.push(frameMs);
        gestureScrolled += d;
        scrolled += d;
        if (gestureScrolled >= targetDist) break;
        v *= 0.95; // momentum decay per frame
      }
      // guarantee at least one delta even for a degenerate draw
      if (deltas.length === 0) {
        const d = jittered(clamp(v0 * dt, 2, 40), undefined);
        deltas.push(d);
        interDeltaMs.push(16.7);
        scrolled += d;
      }
    }

    // inter-gesture transit dwell as the previous gesture's postDwell — θ nudged
    // up (mean 800→920 ms, slightly slower, never faster) and the ceiling raised
    // 4000→6000 so a real "got distracted mid-scroll" pause occasionally lands.
    const postDwellMs = clamp(rng.gamma(2, 460), 80, 6000);
    gestures.push({ kind, deltas, interDeltaMs, postDwellMs });
  }

  return gestures;
}
