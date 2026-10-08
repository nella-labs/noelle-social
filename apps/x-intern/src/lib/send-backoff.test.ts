import { describe, expect, it } from "vitest";
import {
  escalateBackoff,
  isInCooldown,
  shouldClearSendBackoff,
} from "./send-backoff.js";

const NOW = 1_700_000_000_000; // fixed epoch; every fn takes nowMs as an arg (no Date.now)
const MIN = 60_000;

describe("escalateBackoff", () => {
  it("walks the ladder exactly (15 → 30 → 60 → 120 cap)", () => {
    const steps: Array<[number, number, number]> = [
      // [prevStreak, expectedStreak, expectedMins]
      [0, 1, 15],
      [1, 2, 30],
      [2, 3, 60],
      [3, 4, 120],
      [4, 5, 120], // cap holds
      [9, 10, 120], // cap still holds far up the ladder
    ];
    for (const [prev, streak, mins] of steps) {
      const b = escalateBackoff(prev, NOW);
      expect(b.streak).toBe(streak);
      expect(b.mins).toBe(mins);
      expect(b.cooldownUntilMs).toBe(NOW + mins * MIN);
    }
  });
});

describe("isInCooldown", () => {
  it("no state (null persisted, undefined in-memory) → false", () => {
    expect(isInCooldown(null, undefined, NOW)).toBe(false);
  });

  it("a persisted cooldown just past now → true", () => {
    expect(isInCooldown(NOW + 1, undefined, NOW)).toBe(true);
  });

  it("a persisted cooldown in the past → false", () => {
    expect(isInCooldown(NOW - 1000, undefined, NOW)).toBe(false);
  });

  it("honors max(in-memory, persisted) — the larger of the two wins", () => {
    // In-memory says 'done' (past), persisted still active → still in cooldown.
    expect(isInCooldown(NOW + 5 * MIN, NOW - 1000, NOW)).toBe(true);
    // Persisted null, in-memory still active → still in cooldown.
    expect(isInCooldown(null, NOW + 5 * MIN, NOW)).toBe(true);
  });

  it("a crash-set legit cooldown self-heals at ≤120 min (never permanently wedges)", () => {
    const setAt = NOW;
    const until = escalateBackoff(3, setAt).cooldownUntilMs; // streak 4 → +120 min
    expect(isInCooldown(until, undefined, setAt + 119 * MIN)).toBe(true);
    expect(isInCooldown(until, undefined, setAt + 120 * MIN)).toBe(false);
  });

  it("keeps an explicit six-hour policy restriction active beyond the 429 ladder cap", () => {
    const policyUntil = NOW + 6 * 3600_000;
    expect(isInCooldown(policyUntil, undefined, NOW + 120 * MIN)).toBe(true);
    expect(isInCooldown(policyUntil, NOW + 30 * MIN, policyUntil - 1)).toBe(true);
    expect(isInCooldown(policyUntil, undefined, policyUntil)).toBe(false);
  });

  it("honors a stored future deadline until that fixed instant", () => {
    const until = NOW + 10 * 3600_000;
    expect(isInCooldown(until, undefined, NOW)).toBe(true);
    expect(isInCooldown(until, undefined, until - 1)).toBe(true);
    expect(isInCooldown(until, undefined, until)).toBe(false);
  });
});

describe("shouldClearSendBackoff", () => {
  it("clears only on a clean send: sent, not rate-limited, not systemic-403", () => {
    expect(shouldClearSendBackoff({ sent: true, rateLimited: false, systemicForbidden: false })).toBe(true);
  });

  it("does NOT clear when nothing sent", () => {
    expect(shouldClearSendBackoff({ sent: false, rateLimited: false, systemicForbidden: false })).toBe(false);
  });

  it("does NOT clear when the tick was rate-limited (even if something sent)", () => {
    expect(shouldClearSendBackoff({ sent: true, rateLimited: true, systemicForbidden: false })).toBe(false);
  });

  it("does NOT clear when a systemic reply-403 set the policy cooldown THIS tick — the regression guard", () => {
    // 1 clean send + a systemic 403 run co-occur before the batch breaks. The
    // policy cooldown was just set; clearing here would wipe it and resume
    // posting into the account/app reply block. Must stay held.
    expect(shouldClearSendBackoff({ sent: true, rateLimited: false, systemicForbidden: true })).toBe(false);
  });
});
