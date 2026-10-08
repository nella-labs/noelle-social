import { describe, expect, it } from "vitest";
import { computeAutoSendSchedule, autoSendRemainingBudget } from "./autosend-schedule.js";

// Deterministic RNG so the schedule is reproducible.
function seededRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0xffffffff;
  };
}

const BASE = Date.UTC(2026, 5, 8, 14, 0, 0); // 14:00 UTC, outside any quiet window

describe("computeAutoSendSchedule", () => {
  it("produces exactly `count` strictly-ascending times", () => {
    const out = computeAutoSendSchedule({
      count: 20,
      startAtMs: BASE,
      minGapSec: 60,
      maxGapSec: 600,
      rng: seededRng(1),
    });
    expect(out).toHaveLength(20);
    for (let i = 1; i < out.length; i++) expect(out[i]!).toBeGreaterThan(out[i - 1]!);
  });

  it("never bursts: every gap respects [min,max] (no 10-in-2-seconds)", () => {
    const out = computeAutoSendSchedule({
      count: 30,
      startAtMs: BASE,
      minGapSec: 60,
      maxGapSec: 600,
      rng: seededRng(7),
    });
    let prev = BASE;
    for (const t of out) {
      const gapSec = (t - prev) / 1000;
      expect(gapSec).toBeGreaterThanOrEqual(60);
      expect(gapSec).toBeLessThanOrEqual(600);
      prev = t;
    }
  });

  it("the first send is offset from start (never immediate)", () => {
    const [first] = computeAutoSendSchedule({
      count: 1,
      startAtMs: BASE,
      minGapSec: 60,
      maxGapSec: 600,
      rng: seededRng(3),
    });
    expect(first! - BASE).toBeGreaterThanOrEqual(60_000);
  });

  it("pushes sends out of the overnight quiet window", () => {
    // Start at 03:30 UTC inside a 04:00–12:00 quiet window with big gaps so we
    // cross into it; every resulting time must be outside 04:00–12:00.
    const out = computeAutoSendSchedule({
      count: 15,
      startAtMs: Date.UTC(2026, 5, 8, 3, 30, 0),
      minGapSec: 120,
      maxGapSec: 300,
      quietStartHourUtc: 4,
      quietEndHourUtc: 12,
      rng: seededRng(11),
    });
    for (const t of out) {
      const h = new Date(t).getUTCHours();
      expect(h >= 4 && h < 12).toBe(false);
    }
  });

  it("is deterministic for a fixed seed", () => {
    const a = computeAutoSendSchedule({ count: 10, startAtMs: BASE, minGapSec: 60, maxGapSec: 600, rng: seededRng(42) });
    const b = computeAutoSendSchedule({ count: 10, startAtMs: BASE, minGapSec: 60, maxGapSec: 600, rng: seededRng(42) });
    expect(a).toEqual(b);
  });
});

describe("autoSendRemainingBudget", () => {
  it("fresh day → full cap", () => {
    expect(autoSendRemainingBudget({ cap: 50, sentLast24h: 0, pendingScheduled: 0 })).toBe(50);
  });
  it("partial usage subtracts both sent + pending", () => {
    expect(autoSendRemainingBudget({ cap: 50, sentLast24h: 10, pendingScheduled: 5 })).toBe(35);
  });
  it("at the ceiling → 0", () => {
    expect(autoSendRemainingBudget({ cap: 50, sentLast24h: 40, pendingScheduled: 10 })).toBe(0);
  });
  it("over the ceiling never goes negative", () => {
    expect(autoSendRemainingBudget({ cap: 50, sentLast24h: 60, pendingScheduled: 5 })).toBe(0);
  });
  it("cap 0 → 0", () => {
    expect(autoSendRemainingBudget({ cap: 0, sentLast24h: 0, pendingScheduled: 0 })).toBe(0);
  });
  it("fractional cap is floored", () => {
    expect(autoSendRemainingBudget({ cap: 50.9, sentLast24h: 0, pendingScheduled: 0 })).toBe(50);
  });
  it("negative inputs are clamped to 0 used", () => {
    expect(autoSendRemainingBudget({ cap: 50, sentLast24h: -3, pendingScheduled: 0 })).toBe(50);
  });
});
