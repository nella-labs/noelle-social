import { describe, it, expect } from "vitest";
import { daysSince, warmupCapMultiplier } from "../src/lib/warmup.js";

const DAY = 86_400_000;

describe("warmup", () => {
  it("counts whole days since start, never negative", () => {
    const start = 1_000_000_000_000;
    expect(daysSince(start, start)).toBe(0);
    expect(daysSince(start, start + DAY - 1)).toBe(0);
    expect(daysSince(start, start + DAY)).toBe(1);
    expect(daysSince(start, start + 10 * DAY)).toBe(10);
    expect(daysSince(start, start - DAY)).toBe(0); // clock skew, never negative
  });

  it("ramps the daily-cap multiplier weekly to full at week 4", () => {
    const start = 1_000_000_000_000;
    const at = (days: number) => warmupCapMultiplier(start, start + days * DAY);
    expect(at(0)).toBeCloseTo(0.4);
    expect(at(6)).toBeCloseTo(0.4); // still week 0
    expect(at(7)).toBeCloseTo(0.55); // week 1
    expect(at(14)).toBeCloseTo(0.7); // week 2
    expect(at(21)).toBeCloseTo(0.85); // week 3
    expect(at(28)).toBeCloseTo(1.0); // week 4 = full
    expect(at(100)).toBe(1.0); // capped at full
  });

  it("never exceeds 1 and never drops below the week-0 floor", () => {
    const start = 1_000_000_000_000;
    for (let d = 0; d < 60; d++) {
      const m = warmupCapMultiplier(start, start + d * DAY);
      expect(m).toBeGreaterThanOrEqual(0.4);
      expect(m).toBeLessThanOrEqual(1);
    }
  });
});
