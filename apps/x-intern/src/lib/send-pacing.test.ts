import { describe, expect, it } from "vitest";
import { isWithinInterSendFloor, nextSendAllowedAt } from "./send-pacing.js";

// Both fns take nowMs + rand as ARGUMENTS (no Date.now / Math.random inside) so
// they stay deterministic per NON-NEGOTIABLE rule 4.
describe("isWithinInterSendFloor", () => {
  it("fresh process (no next-allowed set) → false (sends immediately, one/tick)", () => {
    expect(isWithinInterSendFloor({ nowMs: 1000, nextSendAllowedAtMs: undefined })).toBe(false);
  });

  it("now before next-allowed → true (defer)", () => {
    expect(isWithinInterSendFloor({ nowMs: 1000, nextSendAllowedAtMs: 2000 })).toBe(true);
  });

  it("now at/after next-allowed → false (allowed)", () => {
    expect(isWithinInterSendFloor({ nowMs: 2000, nextSendAllowedAtMs: 2000 })).toBe(false);
    expect(isWithinInterSendFloor({ nowMs: 3000, nextSendAllowedAtMs: 2000 })).toBe(false);
  });
});

describe("nextSendAllowedAt", () => {
  it("rand=0 → now + min", () => {
    expect(nextSendAllowedAt({ nowMs: 1000, minMs: 60_000, maxMs: 120_000, rand: 0 })).toBe(61_000);
  });

  it("rand=1 → now + max", () => {
    expect(nextSendAllowedAt({ nowMs: 1000, minMs: 60_000, maxMs: 120_000, rand: 1 })).toBe(121_000);
  });

  it("rand=0.5 → now + midpoint", () => {
    expect(nextSendAllowedAt({ nowMs: 1000, minMs: 60_000, maxMs: 120_000, rand: 0.5 })).toBe(91_000);
  });

  it("rand out of [0,1] is clamped (<0 → min, >1 → max)", () => {
    expect(nextSendAllowedAt({ nowMs: 1000, minMs: 60_000, maxMs: 120_000, rand: -1 })).toBe(61_000);
    expect(nextSendAllowedAt({ nowMs: 1000, minMs: 60_000, maxMs: 120_000, rand: 2 })).toBe(121_000);
  });

  it("min > max is tolerated via an internal lo/hi swap", () => {
    // Swapped bounds: rand=0 still returns now + the smaller bound.
    expect(nextSendAllowedAt({ nowMs: 1000, minMs: 120_000, maxMs: 60_000, rand: 0 })).toBe(61_000);
    expect(nextSendAllowedAt({ nowMs: 1000, minMs: 120_000, maxMs: 60_000, rand: 1 })).toBe(121_000);
  });
});
