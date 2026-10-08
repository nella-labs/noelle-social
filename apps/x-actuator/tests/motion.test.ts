import { describe, it, expect } from "vitest";
import {
  mousePath,
  planScrollSteps,
  typingDelays,
  mousePlan,
  clickPoint,
  tremor,
  hoverDwellMs,
  planScrollGestures,
  type Point,
} from "../src/lib/motion.js";
import { makeRng } from "../src/lib/rng.js";

// --- helpers ---------------------------------------------------------------

function mean(xs: number[]): number {
  return xs.reduce((s, x) => s + x, 0) / xs.length;
}
function cv(xs: number[]): number {
  const m = mean(xs);
  const variance = xs.reduce((s, x) => s + (x - m) ** 2, 0) / xs.length;
  return Math.sqrt(variance) / Math.abs(m);
}
function dist(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}
// Perpendicular distance of point p from the infinite line through a→b.
function distFromChord(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy);
  if (len === 0) return dist(p, a);
  // |cross product| / |chord|
  return Math.abs((p.x - a.x) * dy - (p.y - a.y) * dx) / len;
}

// ===========================================================================
// EXISTING (legacy) PLANNERS — must keep passing
// ===========================================================================

describe("legacy motion planners", () => {
  it("mousePath starts near `from`, ends exactly at `to`, has intermediate points", () => {
    const path = mousePath({ x: 10, y: 10 }, { x: 200, y: 140 }, makeRng(2));
    expect(path.length).toBeGreaterThan(3);
    expect(path[path.length - 1]).toEqual({ x: 200, y: 140 });
    expect(Math.abs(path[0]!.x - 10)).toBeLessThanOrEqual(30);
  });

  it("mousePath makes net progress toward the target", () => {
    const path = mousePath({ x: 0, y: 0 }, { x: 300, y: 0 }, makeRng(9));
    expect(path[Math.floor(path.length / 2)]!.x).toBeGreaterThan(0);
    expect(path[Math.floor(path.length / 2)]!.x).toBeLessThan(300);
  });

  it("planScrollSteps varies and sums past the target", () => {
    const steps = planScrollSteps(makeRng(5), 2000);
    expect(steps.reduce((s, d) => s + d, 0)).toBeGreaterThan(1000);
    expect(new Set(steps).size).toBeGreaterThan(1);
  });

  it("typingDelays returns one delay per character, all positive", () => {
    const d = typingDelays(makeRng(1), 11);
    expect(d).toHaveLength(11);
    expect(d.every((x) => x > 0)).toBe(true);
  });

  it("is deterministic for a fixed seed", () => {
    expect(mousePath({ x: 1, y: 2 }, { x: 9, y: 9 }, makeRng(7)))
      .toEqual(mousePath({ x: 1, y: 2 }, { x: 9, y: 9 }, makeRng(7)));
  });
});

// ===========================================================================
// MOUSE MODEL (§3c)
// ===========================================================================

describe("mousePlan — sigma-lognormal velocity + overshoot + variable density", () => {
  const from: Point = { x: 100, y: 600 };
  const to: Point = { x: 520, y: 240 }; // chord ~556px
  const W = 80;

  it("is deterministic for a fixed seed", () => {
    const a = mousePlan(from, to, W, makeRng(42));
    const b = mousePlan(from, to, W, makeRng(42));
    expect(a).toEqual(b);
  });

  it("produces a variable point density in the 18–40 band for a 300–600px move", () => {
    const plan = mousePlan(from, to, W, makeRng(11));
    expect(plan.points.length).toBeGreaterThanOrEqual(18);
    expect(plan.points.length).toBeLessThanOrEqual(40);
    // one sleep per point
    expect(plan.sleepsMs.length).toBe(plan.points.length);
    expect(plan.sleepsMs.every((s) => s >= 0)).toBe(true);
  });

  it("last `points` element is at `to` (the corrective segment lands the click later)", () => {
    const plan = mousePlan(from, to, W, makeRng(3));
    const last = plan.points[plan.points.length - 1]!;
    expect(dist(last, to)).toBeLessThanOrEqual(1.5);
  });

  it("velocity peak (step distance / sleep) occurs in 35–60% of the path index", () => {
    // average over several seeds: peak should be in the middle band, never at the ends.
    const fracs: number[] = [];
    for (let seed = 0; seed < 24; seed++) {
      const plan = mousePlan(from, to, W, makeRng(seed * 7 + 1));
      const n = plan.points.length;
      let bestIdx = 1;
      let bestV = -Infinity;
      for (let i = 1; i < n; i++) {
        const d = dist(plan.points[i]!, plan.points[i - 1]!);
        const dt = Math.max(plan.sleepsMs[i]!, 0.001);
        const v = d / dt;
        if (v > bestV) {
          bestV = v;
          bestIdx = i;
        }
      }
      fracs.push(bestIdx / (n - 1));
      // never at the very first or very last step
      expect(bestIdx).toBeGreaterThan(0);
      expect(bestIdx).toBeLessThan(n - 1);
    }
    const m = mean(fracs);
    expect(m).toBeGreaterThanOrEqual(0.35);
    expect(m).toBeLessThanOrEqual(0.6);
  });

  it("CV of sleepsMs exceeds 0.3 (non-uniform, envelope-derived)", () => {
    const plan = mousePlan(from, to, W, makeRng(8));
    expect(cv(plan.sleepsMs)).toBeGreaterThan(0.3);
  });

  it("overshoot lies beyond `to` along the travel direction", () => {
    for (let seed = 0; seed < 12; seed++) {
      const plan = mousePlan(from, to, W, makeRng(seed * 13 + 2));
      const travel = { x: to.x - from.x, y: to.y - from.y };
      const beyond = { x: plan.overshoot.x - to.x, y: plan.overshoot.y - to.y };
      // projection of the overshoot vector onto the travel direction must be > 0
      const projection = beyond.x * travel.x + beyond.y * travel.y;
      expect(projection).toBeGreaterThan(0);
      // and not absurdly far
      expect(dist(plan.overshoot, to)).toBeLessThan(40);
    }
  });

  it("correctFrom equals the overshoot point", () => {
    const plan = mousePlan(from, to, W, makeRng(5));
    expect(plan.correctFrom).toEqual(plan.overshoot);
  });

  it("at least one path point is off the straight chord by a meaningful margin (curved)", () => {
    const plan = mousePlan(from, to, W, makeRng(6));
    const maxOff = Math.max(...plan.points.map((p) => distFromChord(p, from, to)));
    expect(maxOff).toBeGreaterThan(8);
  });

  it("handles a tiny move without crashing and still ends at `to`", () => {
    const plan = mousePlan({ x: 10, y: 10 }, { x: 14, y: 12 }, 30, makeRng(1));
    expect(plan.points.length).toBeGreaterThanOrEqual(2);
    const last = plan.points[plan.points.length - 1]!;
    expect(dist(last, { x: 14, y: 12 })).toBeLessThanOrEqual(1.5);
  });
});

describe("clickPoint — 2D-Gaussian, ~70% edge→center", () => {
  const rect = { x: 100, y: 200, width: 160, height: 48 };
  const cx = rect.x + rect.width / 2;
  const cy = rect.y + rect.height / 2;

  it("is deterministic for a fixed seed", () => {
    expect(clickPoint(rect, makeRng(4))).toEqual(clickPoint(rect, makeRng(4)));
  });

  it("always stays inside the rect", () => {
    for (let seed = 0; seed < 200; seed++) {
      const p = clickPoint(rect, makeRng(seed + 1));
      expect(p.x).toBeGreaterThanOrEqual(rect.x);
      expect(p.x).toBeLessThanOrEqual(rect.x + rect.width);
      expect(p.y).toBeGreaterThanOrEqual(rect.y);
      expect(p.y).toBeLessThanOrEqual(rect.y + rect.height);
    }
  });

  it("mean is biased toward center but is never exactly the geometric center", () => {
    const pts: Point[] = [];
    for (let seed = 0; seed < 400; seed++) pts.push(clickPoint(rect, makeRng(seed * 3 + 1)));
    const mx = mean(pts.map((p) => p.x));
    const my = mean(pts.map((p) => p.y));
    // close to center (within ~15% of half-extent)
    expect(Math.abs(mx - cx)).toBeLessThan(rect.width * 0.15);
    expect(Math.abs(my - cy)).toBeLessThan(rect.height * 0.15);
    // but a single sample essentially never lands on the exact center
    const exact = pts.filter((p) => p.x === cx && p.y === cy).length;
    expect(exact).toBe(0);
  });
});

describe("tremor — 8–12Hz micro-tremor on every coordinate", () => {
  const base: Point = { x: 300, y: 300 };

  it("is deterministic for a fixed (seed, time)", () => {
    const rngState = () => makeRng(77);
    expect(tremor(base, 123, rngState())).toEqual(tremor(base, 123, rngState()));
  });

  it("stays within a few px of base", () => {
    for (let t = 0; t < 500; t += 7) {
      const p = tremor(base, t, makeRng(9));
      expect(dist(p, base)).toBeLessThan(4);
    }
  });

  it("varies over time", () => {
    const rng = makeRng(21);
    const a = tremor(base, 0, rng);
    const b = tremor(base, 33, rng);
    const c = tremor(base, 66, rng);
    // not all identical
    const allSame = a.x === b.x && a.y === b.y && b.x === c.x && b.y === c.y;
    expect(allSame).toBe(false);
  });
});

describe("hoverDwellMs — logNormal ~220ms median, clamped [80,650]", () => {
  it("is deterministic for a fixed seed", () => {
    expect(hoverDwellMs(makeRng(2))).toBe(hoverDwellMs(makeRng(2)));
  });

  it("always lands in [80,650]", () => {
    for (let seed = 0; seed < 300; seed++) {
      const v = hoverDwellMs(makeRng(seed + 1));
      expect(v).toBeGreaterThanOrEqual(80);
      expect(v).toBeLessThanOrEqual(650);
    }
  });

  it("median is in a plausible band around ~220ms", () => {
    const xs: number[] = [];
    for (let seed = 0; seed < 400; seed++) xs.push(hoverDwellMs(makeRng(seed * 5 + 1)));
    xs.sort((a, b) => a - b);
    const median = xs[Math.floor(xs.length / 2)]!;
    expect(median).toBeGreaterThan(150);
    expect(median).toBeLessThan(320);
  });
});

// ===========================================================================
// SCROLL ENGINE (§3a)
// ===========================================================================

describe("planScrollGestures — momentum scroll mixture", () => {
  it("is deterministic for a fixed seed", () => {
    expect(planScrollGestures(makeRng(31), 3000)).toEqual(planScrollGestures(makeRng(31), 3000));
  });

  it("total scrolled is within ±15% of totalPx", () => {
    for (const target of [1500, 3000, 6000]) {
      for (let seed = 0; seed < 12; seed++) {
        const gestures = planScrollGestures(makeRng(seed * 17 + 3), target);
        const total = gestures.reduce(
          (s, g) => s + g.deltas.reduce((a, d) => a + d, 0),
          0,
        );
        expect(total).toBeGreaterThan(target * 0.85);
        expect(total).toBeLessThan(target * 1.15);
      }
    }
  });

  it("never emits the same deltaY twice consecutively within a gesture", () => {
    for (let seed = 0; seed < 30; seed++) {
      const gestures = planScrollGestures(makeRng(seed * 11 + 1), 4000);
      for (const g of gestures) {
        for (let i = 1; i < g.deltas.length; i++) {
          expect(g.deltas[i]).not.toBe(g.deltas[i - 1]);
        }
      }
    }
  });

  it("flick gestures decay in magnitude (momentum), trend-wise and at least once strictly", () => {
    // A flick is the dominant (p=0.45) type. Its peak velocity decays ×0.95/frame,
    // so the |delta| envelope must trend downward. The ±8% wheel jitter means a
    // single frame can wobble up, so we assert TWO things:
    //   (1) TREND: for EVERY multi-notch flick, the last delta is clearly smaller
    //       than the first and the series never wobbles up by more than the ±8%
    //       jitter band can explain (≤ prev × 1.18, comfortably above 2·8%).
    //   (2) EXISTENCE: at least one flick is *strictly* non-increasing (a clean
    //       decay with no wobble) — proving the underlying envelope is monotone.
    let foundStrictlyMonotone = false;
    let checkedAnyFlick = false;
    for (let seed = 0; seed < 60; seed++) {
      const gestures = planScrollGestures(makeRng(seed * 7 + 5), 8000);
      for (const g of gestures) {
        if (g.kind !== "flick") continue;
        const mags = g.deltas.map((d) => Math.abs(d));
        if (mags.length < 4) continue;
        checkedAnyFlick = true;

        // (1) trend: end well below start, no frame-to-frame jump beyond the jitter band
        expect(mags[mags.length - 1]!).toBeLessThan(mags[0]!);
        for (let i = 1; i < mags.length; i++) {
          expect(mags[i]!).toBeLessThanOrEqual(mags[i - 1]! * 1.18 + 1e-9);
        }

        // (2) existence of a perfectly clean decay
        let strict = true;
        for (let i = 1; i < mags.length; i++) {
          if (mags[i]! > mags[i - 1]! + 1e-9) {
            strict = false;
            break;
          }
        }
        if (strict) foundStrictlyMonotone = true;
      }
    }
    expect(checkedAnyFlick).toBe(true);
    expect(foundStrictlyMonotone).toBe(true);
  });

  it("CV of all inter-delta times exceeds 0.4 (non-uniform spacing)", () => {
    const all: number[] = [];
    for (let seed = 0; seed < 8; seed++) {
      const gestures = planScrollGestures(makeRng(seed * 23 + 2), 6000);
      for (const g of gestures) all.push(...g.interDeltaMs);
    }
    expect(all.length).toBeGreaterThan(20);
    expect(cv(all)).toBeGreaterThan(0.4);
  });

  it("each gesture has one inter-delta gap per delta and a tagged kind", () => {
    const gestures = planScrollGestures(makeRng(99), 5000);
    expect(gestures.length).toBeGreaterThan(0);
    for (const g of gestures) {
      expect(g.deltas.length).toBe(g.interDeltaMs.length);
      expect(g.deltas.length).toBeGreaterThan(0);
      expect(["flick", "slow-drag", "micro-nudge", "back-scroll"]).toContain(g.kind);
    }
  });
});
