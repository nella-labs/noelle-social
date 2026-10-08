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

