import { describe, it, expect } from "vitest";
import { planTimeline } from "../src/lib/scheduler.js";
import { makeRng } from "../src/lib/rng.js";
import { WRITE_CURFEW_ENABLED } from "../src/lib/curfew.js";

const caps = { likes: 120, comments: 80, dms: 10 };
const start = 1_750_000_000_000; // fixed epoch ms

function plan(over?: Partial<Parameters<typeof planTimeline>[0]>) {
  return planTimeline({
    params: { windowHours: 8, targetComments: 30, targetLikes: 60 },
    approvedDms: 2,
    caps,
    startMs: start,
    deepNightTaper: false,
    rng: makeRng(123),
    ...over,
  });
}

// Helpers
function computeCV(values: number[]): number {
  if (values.length < 2) return 0;
  const mean = values.reduce((s, v) => s + v, 0) / values.length;
  if (mean === 0) return 0;
  const variance = values.reduce((s, v) => s + (v - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance) / mean;
}

function lag1Autocorrelation(values: number[]): number {
  if (values.length < 3) return 0;
  const mean = values.reduce((s, v) => s + v, 0) / values.length;
  let num = 0;
  let den = 0;
  for (let i = 0; i < values.length - 1; i++) {
    num += (values[i]! - mean) * (values[i + 1]! - mean);
  }
  for (const v of values) den += (v - mean) ** 2;
  if (den === 0) return 0;
  return num / den;
}

describe("planTimeline", () => {
  // ── PRESERVED: non-exact (±20%) counts ──────────────────────────────────────
  it("emits action counts within the volume band (0.72x–1.2x of target)", () => {
    const { actions } = plan();
    const comments = actions.filter((a) => a.kind === "comment").length;
    const likes = actions.filter((a) => a.kind === "like").length;
    const dms = actions.filter((a) => a.kind === "dm").length;
    // targets: comments=30, likes=60, dms=2. Volume factor widened DOWN to 0.72
    // floor (fewer on average = safer) with the 1.2 cap unchanged (never more).
    expect(comments).toBeGreaterThanOrEqual(Math.floor(0.72 * 30));
    expect(comments).toBeLessThanOrEqual(Math.ceil(1.2 * 30));
    expect(likes).toBeGreaterThanOrEqual(Math.floor(0.72 * 60));
    expect(likes).toBeLessThanOrEqual(Math.ceil(1.2 * 60));
    expect(dms).toBeGreaterThanOrEqual(Math.floor(0.72 * 2));
    expect(dms).toBeLessThanOrEqual(Math.ceil(1.2 * 2));
  });

  // ── PRESERVED: window bounds ─────────────────────────────────────────────────
  it("keeps every action inside [start, start+window]", () => {
    const { actions } = plan();
    const end = start + 8 * 3600_000;
    for (const a of actions) {
      expect(a.atMs).toBeGreaterThanOrEqual(start);
      expect(a.atMs).toBeLessThanOrEqual(end);
    }
  });

  // ── PRESERVED: sorted ascending ──────────────────────────────────────────────
  it("returns actions sorted ascending by time", () => {
    const { actions } = plan();
    for (let i = 1; i < actions.length; i++) {
      expect(actions[i]!.atMs).toBeGreaterThanOrEqual(actions[i - 1]!.atMs);
    }
  });

  // ── PRESERVED: first action fires quickly ────────────────────────────────────
  it("fires the first action within 8s of startMs", () => {
    const { actions } = plan();
    expect(actions[0]!.atMs).toBeLessThanOrEqual(start + 8_000);
  });

  // ── UPDATED: clamp is tested against the post-volume-variation actual value ──
  it("clamps targets above caps and records the clamp", () => {
    const { actions, clamps } = plan({
      params: { windowHours: 8, targetComments: 200, targetLikes: 60 },
    });
    // 200 * up-to-1.2 = 240, still above cap 80 → clamped
    expect(actions.filter((a) => a.kind === "comment").length).toBeLessThanOrEqual(80);
    // A ClampNote must appear for comment
    expect(clamps.some((c) => c.kind === "comment")).toBe(true);
  });

  // ── PRESERVED: determinism per seed ─────────────────────────────────────────
  it("is deterministic for a fixed seed", () => {
    expect(plan().actions).toEqual(plan().actions);
  });

  // ── NEW: inter-action CV in human band [0.8, 2.0] ───────────────────────────
  it("inter-action CV is in the human band [0.8, 2.0]", () => {
    // Use a large action set over 8h daytime to get a meaningful CV sample.
    // Start at noon UTC so no curfew interference.
    const noonStart = new Date("2025-01-15T12:00:00.000Z").getTime();
    const { actions } = planTimeline({
      params: { windowHours: 8, targetComments: 30, targetLikes: 60 },
      approvedDms: 0,
      caps,
      startMs: noonStart,
      deepNightTaper: false,
      rng: makeRng(42),
    });
    const gaps: number[] = [];
    for (let i = 1; i < actions.length; i++) {
      gaps.push(actions[i]!.atMs - actions[i - 1]!.atMs);
    }
    const cv = computeCV(gaps);
    expect(cv).toBeGreaterThanOrEqual(0.8);
    expect(cv).toBeLessThanOrEqual(2.0);
  });

  // ── overnight curfew [23:00, 06:00) — toggle-aware ─────────────────────────
  // The curfew is a single switch (src/lib/curfew.ts, WRITE_CURFEW_ENABLED).
  // When ON, the scheduler shifts writes out of the band; when OFF (current
  // operator setting), actions may land at any hour.
  it("honors the WRITE_CURFEW_ENABLED switch for the overnight band", () => {
    // Window that spans local 22:00→08:00 (10h), crossing midnight.
    // We use local time directly: set local 22:00 on a fixed date.
    const eveningStart = (() => {
      const d = new Date("2025-01-15T12:00:00.000Z"); // noon UTC as base
      // Advance to local 22:00 on that calendar day
      const localHour = d.getHours();
      d.setTime(d.getTime() + (22 - localHour) * 3600_000);
      return d.getTime();
    })();
    const { actions } = planTimeline({
      params: { windowHours: 10, targetComments: 20, targetLikes: 40 },
      approvedDms: 2,
      caps,
      startMs: eveningStart,
      deepNightTaper: false,
      rng: makeRng(99),
    });
    const overnight = actions.filter((a) => {
      const h = new Date(a.atMs).getHours();
      return h >= 23 || h < 6;
    });
    if (WRITE_CURFEW_ENABLED) {
      expect(overnight.length).toBe(0); // curfew ON → nothing in the band
    } else {
      // curfew OFF (current) → the 10h window straddling midnight DOES place
      // writes overnight; the point of disabling it is exactly this.
      expect(overnight.length).toBeGreaterThan(0);
    }
  });

  // ── AR(1) fingerprint — lag-1 autocorrelation of gaps ──────────────────────
  // The per-action tempo is an AR(1) process (rho in [0.2,0.6]), so WITHIN a
  // burst gaps are positively autocorrelated. Any single session also mixes in
  // between-burst idle jumps (a long gap, then the next cluster resumes) that
  // offset that correlation, so ONE session's pooled lag-1 ACF is noisy and
  // centred near zero. The fingerprint shows up robustly as a POSITIVE MEAN
  // across sessions, while no single session is strongly anti-correlated (a
  // sawtooth would be the mechanical tell). Widening the schedule variance
  // widened the per-session ACF SPREAD but left the mean positive — so this
  // asserts the mean over many sessions (stronger than the old single-seed
  // check), plus a worst-case floor.
  it("keeps a positive-mean AR(1) fingerprint with no strongly anti-correlated session", () => {
    const noonStart = new Date("2025-01-15T12:00:00.000Z").getTime();
    const N = 80;
    let sum = 0;
    let worst = 1;
    for (let seed = 1; seed <= N; seed++) {
      const { actions } = planTimeline({
        params: { windowHours: 8, targetComments: 30, targetLikes: 60 },
        approvedDms: 0,
        caps,
        startMs: noonStart,
        deepNightTaper: false,
        rng: makeRng(seed),
      });
      const gaps: number[] = [];
      for (let i = 1; i < actions.length; i++) {
        gaps.push(actions[i]!.atMs - actions[i - 1]!.atMs);
      }
      const acf = lag1Autocorrelation(gaps);
      sum += acf;
      worst = Math.min(worst, acf);
    }
    // AR(1) tempo present on average, and no session is a mechanical sawtooth.
    expect(sum / N).toBeGreaterThan(0.01);
    expect(worst).toBeGreaterThan(-0.2);
  });

  // ── NEW: stepped-away pause layer draws from an INDEPENDENT rng ─────────────
  it("stepped-away pauses never perturb the main RNG stream (kind order is startMs-independent)", () => {
    // The pause layer's rng is seeded from (startMs, total, window) — changing
    // startMs changes WHICH gaps get an extra pause, but the main stream (volume
    // factor, shuffle, bursts, tempo) consumes zero pause draws, so the planned
    // kind ORDER is identical across startMs values. Pauses only push the tail
    // past the window end (dropped + surfaced as ClampNotes), so the shorter
    // plan's kind sequence must be a PREFIX of the longer one — never reshuffled.
    const kindsAt = (startMs: number) =>
      planTimeline({
        params: { windowHours: 8, targetComments: 30, targetLikes: 60 },
        approvedDms: 2,
        caps,
        startMs,
        deepNightTaper: false,
        rng: makeRng(123),
      }).actions.map((a) => a.kind);
    // Different startMs ⇒ different pauseRng seed; same main seed ⇒ same order.
    const a = kindsAt(start);
    const b = kindsAt(start + 987_654_321);
    const n = Math.min(a.length, b.length);
    expect(n).toBeGreaterThan(0);
    expect(a.slice(0, n)).toEqual(b.slice(0, n));
  });

  // ── NEW: ±20% volume variation — multiple seeds never all produce the same count ─
  it("total action count varies across seeds (±20% volume jitter)", () => {
    const counts = [1, 2, 3, 4, 5].map((seed) =>
      planTimeline({
        params: { windowHours: 8, targetComments: 30, targetLikes: 60 },
        approvedDms: 2,
        caps,
        startMs: start,
        deepNightTaper: false,
        rng: makeRng(seed),
      }).actions.length,
    );
    // Not all identical
    const allSame = counts.every((c) => c === counts[0]);
    expect(allSame).toBe(false);
  });

  // ── NEW: ClampNote emitted when volume variation pushes over cap ─────────────
  it("records a ClampNote when ±20% volume variation would exceed a cap", () => {
    // Set target = cap so +20% always exceeds
    const tightCaps = { likes: 60, comments: 30, dms: 2 };
    // Run many seeds; at least one should exceed and record a clamp
    const clampSeen = [10, 20, 30, 40, 50].some((seed) => {
      const { clamps } = planTimeline({
        params: { windowHours: 8, targetComments: 30, targetLikes: 60 },
        approvedDms: 2,
        caps: tightCaps,
        startMs: start,
        deepNightTaper: false,
        rng: makeRng(seed),
      });
      return clamps.length > 0;
    });
    expect(clampSeen).toBe(true);
  });
});

// A 30-min window with 90 requested actions is the case that produced the
// "nothing happens for ~15 min, then it all fires at once" bug: a single burst
// centered at the midpoint plus fixed multi-hour gaps that overflow the window.
describe("planTimeline — short window pacing", () => {
  const HALF_HOUR = 30 * 60_000;
  // noon UTC start so the overnight curfew never interferes with these assertions
  const noonStart = new Date("2025-01-15T12:00:00.000Z").getTime();
  function shortPlan(seed: number) {
    return planTimeline({
      params: { windowHours: 0.5, targetComments: 30, targetLikes: 60 },
      approvedDms: 0,
      caps,
      startMs: noonStart,
      deepNightTaper: false,
      rng: makeRng(seed),
    });
  }

  it("fires the first action within 8s even in a 30-min window", () => {
    for (let seed = 1; seed <= 5; seed++) {
      const { actions } = shortPlan(seed);
      expect(actions.length).toBeGreaterThan(0);
      expect(actions[0]!.atMs).toBeLessThanOrEqual(noonStart + 8_000);
    }
  });

  it("uses the whole window — the first half is not dead", () => {
    // The old bug: with one burst centered at the midpoint, almost every action
    // landed in the SECOND half. A healthy plan spreads across both halves.
    const mid = noonStart + HALF_HOUR / 2;
    for (let seed = 1; seed <= 5; seed++) {
      const { actions } = shortPlan(seed);
      const firstHalf = actions.filter((a) => a.atMs < mid).length;
      expect(firstHalf / actions.length).toBeGreaterThanOrEqual(0.25);
    }
  });

  it("never clusters actions at the window end", () => {
    // Old bug: overflowed actions all clamped to exactly endMs. Now they drop.
    const end = noonStart + HALF_HOUR;
    for (let seed = 1; seed <= 5; seed++) {
      const { actions } = shortPlan(seed);
      const atEnd = actions.filter((a) => a.atMs >= end - 1).length;
      expect(atEnd).toBeLessThanOrEqual(1);
      for (const a of actions) expect(a.atMs).toBeLessThanOrEqual(end);
    }
  });

  it("keeps a human minimum gap between consecutive actions", () => {
    // 90 actions can't fit in 30 min at a human pace, so the plan holds the
    // minimum gap and drops the overflow rather than firing every few seconds.
    for (let seed = 1; seed <= 5; seed++) {
      const { actions } = shortPlan(seed);
      const gaps: number[] = [];
      for (let i = 1; i < actions.length; i++) gaps.push(actions[i]!.atMs - actions[i - 1]!.atMs);
      const median = gaps.slice().sort((a, b) => a - b)[Math.floor(gaps.length / 2)] ?? 0;
      // median gap should be near the 40s human floor, not 20s (fits-count) or 200s (overflow)
      expect(median).toBeGreaterThanOrEqual(20_000);
    }
  });

  it("records the window-fit shortfall as a ClampNote instead of dropping it silently", () => {
    const { actions, clamps } = shortPlan(1);
    const placed = actions.length;
    // ~90 requested (30c + 60l, ±20%) can't fit a 30-min window at a human pace.
    expect(placed).toBeLessThan(70);
    // The shortfall is reported, not silently swallowed.
    const shortfall = clamps.reduce((n, c) => n + (c.requested - c.allowed), 0);
    expect(shortfall).toBeGreaterThan(0);
  });
});
