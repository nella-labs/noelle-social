import { describe, it, expect } from "vitest";
import { searchExtractCeiling, searchLanesExhausted } from "./discovery-budget.js";

describe("searchExtractCeiling", () => {
  it("reserves the top band of the cap for the watch lane", () => {
    expect(searchExtractCeiling(80, 40)).toBe(40);
    expect(searchExtractCeiling(150, 40)).toBe(110);
  });

  it("never goes negative when the reserve exceeds the cap", () => {
    expect(searchExtractCeiling(30, 40)).toBe(0);
  });

  it("treats a negative reserve as zero (full cap available to search)", () => {
    expect(searchExtractCeiling(80, -10)).toBe(80);
  });
});

describe("searchLanesExhausted", () => {
  it("keeps search lanes running below the ceiling", () => {
    // 30 of an 80 cap with a 40 reserve → ceiling 40 → search still open.
    expect(searchLanesExhausted(30, 80, 40)).toBe(false);
    expect(searchLanesExhausted(39, 80, 40)).toBe(false);
  });

  it("pauses search lanes once the reserved band is reached", () => {
    // At/above the ceiling, only the watch lane may keep drawing.
    expect(searchLanesExhausted(40, 80, 40)).toBe(true);
    expect(searchLanesExhausted(79, 80, 40)).toBe(true);
  });

  it("is disabled when the reserve is 0 (old shared-pool behaviour)", () => {
    // No reserve → search runs right up to the full cap, never pre-empted.
    expect(searchLanesExhausted(79, 80, 0)).toBe(false);
    expect(searchLanesExhausted(0, 80, 0)).toBe(false);
  });

  it("reserves the whole cap for the watch lane when reserve >= cap", () => {
    // ceiling clamps to 0 → search is off from the first extraction.
    expect(searchLanesExhausted(0, 80, 80)).toBe(true);
    expect(searchLanesExhausted(0, 80, 100)).toBe(true);
  });

  it("dissolves the reserve when the daily cap is unlimited", () => {
    // discovery.ts maps LINKEDIN_DAILY_EXTRACT_CAP=0 (unlimited) to the
    // MAX_SAFE_INTEGER sentinel before calling here. The ceiling stays a huge
    // finite number, so the search lane is never pre-empted by the reserve —
    // volume is governed by the goal + backpressure instead.
    expect(searchExtractCeiling(Number.MAX_SAFE_INTEGER, 40)).toBe(Number.MAX_SAFE_INTEGER - 40);
    expect(searchLanesExhausted(1_000_000, Number.MAX_SAFE_INTEGER, 40)).toBe(false);
  });
});
