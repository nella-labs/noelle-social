import { describe, expect, it } from "vitest";
import { DEFAULT_DISCOVERY_SCHEDULE } from "@noelle/actuator-cdp";
import { isXWriteQuiet } from "../src/lib/discovery-curfew.js";

const at = (hour: number, minute = 0) => new Date(2026, 8, 20, hour, minute).getTime();

describe("X discovery write schedule", () => {
  it("allows discovery replies and likes around the clock by default, even on an old curfewed run", () => {
    for (const hour of [0, 1, 3, 8, 9, 23]) {
      expect(isXWriteQuiet(at(hour), true, true, DEFAULT_DISCOVERY_SCHEDULE)).toBe(false);
    }
    expect(isXWriteQuiet(at(3), false, true, DEFAULT_DISCOVERY_SCHEDULE)).toBe(true);
  });

  it("holds all discovery writes in the chosen local window and releases them at its end", () => {
    const schedule = { enabled: true, start: "01:00", end: "09:00" };
    expect(isXWriteQuiet(at(0, 59), true, false, schedule)).toBe(false);
    expect(isXWriteQuiet(at(1), true, false, schedule)).toBe(true);
    expect(isXWriteQuiet(at(8, 59), true, false, schedule)).toBe(true);
    expect(isXWriteQuiet(at(9), true, false, schedule)).toBe(false);
    expect(isXWriteQuiet(at(3), false, false, schedule)).toBe(false);
  });

  it("takes a changed window on the next decision without changing the legacy Auto curfew", () => {
    const first = { enabled: true, start: "01:00", end: "09:00" };
    const changed = { enabled: true, start: "23:00", end: "06:30" };
    expect(isXWriteQuiet(at(8), true, true, first)).toBe(true);
    expect(isXWriteQuiet(at(8), true, true, changed)).toBe(false);
    expect(isXWriteQuiet(at(23, 30), true, false, changed)).toBe(true);
    expect(isXWriteQuiet(at(8), false, true, changed)).toBe(true);
  });
});
