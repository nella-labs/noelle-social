import { describe, it, expect } from "vitest";
import {
  searchExtractCeiling,
  searchLanesExhausted,
  dailyCapReached,
} from "./discovery-budget.js";
import { withinActiveHours } from "./cadence.js";

describe("discovery budget", () => {
  it("reserves the top band of the cap for the watch lane", () => {
    expect(searchExtractCeiling(1000, 200)).toBe(800);
  });

  it("never returns a negative or above-cap ceiling", () => {
    expect(searchExtractCeiling(100, 500)).toBe(0);
    expect(searchExtractCeiling(100, -5)).toBe(100);
  });

  it("pauses the keyword lane once the reserve band is entered", () => {
    expect(searchLanesExhausted(799, 1000, 200)).toBe(false);
    expect(searchLanesExhausted(800, 1000, 200)).toBe(true);
  });

  it("a reserve of 0 disables the reservation entirely", () => {
    expect(searchLanesExhausted(999_999, 1000, 0)).toBe(false);
  });

  it("cap 0 means unlimited — the whole feature is inert by default", () => {
    expect(dailyCapReached(10_000, 0)).toBe(false);
    expect(searchLanesExhausted(10_000, 0, 0)).toBe(false);
  });

  it("keeps keyword discovery active with an unlimited cap and positive reserve", () => {
    for (const extracted of [0, 10_000]) {
      expect(dailyCapReached(extracted, 0)).toBe(false);
      expect(searchLanesExhausted(extracted, 0, 200)).toBe(false);
    }
  });

  it("stops every lane once the full cap is spent", () => {
    expect(dailyCapReached(999, 1000)).toBe(false);
    expect(dailyCapReached(1000, 1000)).toBe(true);
  });

  it("the reserve keeps the watch lane alive past the keyword cutoff", () => {
    // The point of the split: at 900/1000 the keyword lane is done but the
    // watch lane still has 100 of headroom.
    expect(searchLanesExhausted(900, 1000, 200)).toBe(true);
    expect(dailyCapReached(900, 1000)).toBe(false);
  });
});

describe("active-hours gate", () => {
  const env = (start: number, end: number, off = 0) => ({
    X_ACTIVE_HOURS_START: start,
    X_ACTIVE_HOURS_END: end,
    X_TZ_OFFSET_MIN: off,
  });
  const at = (utcHour: number) => Date.UTC(2026, 6, 26, utcHour, 0, 0);

  it("START==END disables the gate (ships inert)", () => {
    for (let h = 0; h < 24; h++) expect(withinActiveHours(env(0, 0), at(h))).toBe(true);
  });

  it("keeps a normal daytime window", () => {
    expect(withinActiveHours(env(8, 23), at(7))).toBe(false);
    expect(withinActiveHours(env(8, 23), at(8))).toBe(true);
    expect(withinActiveHours(env(8, 23), at(22))).toBe(true);
    expect(withinActiveHours(env(8, 23), at(23))).toBe(false);
  });

  it("handles a window that wraps past midnight", () => {
    expect(withinActiveHours(env(22, 6), at(23))).toBe(true);
    expect(withinActiveHours(env(22, 6), at(3))).toBe(true);
    expect(withinActiveHours(env(22, 6), at(12))).toBe(false);
  });

  it("uses the explicit offset, not the server TZ", () => {
    // 13:00 UTC is 08:00 in Bogota (-300), so an 8-23 local window is OPEN.
    expect(withinActiveHours(env(8, 23, -300), at(13))).toBe(true);
    // 12:00 UTC is 07:00 local — still closed.
    expect(withinActiveHours(env(8, 23, -300), at(12))).toBe(false);
  });
});
