import { describe, it, expect } from "vitest";
import {
  shouldAutoStart,
  shouldAutoDrain,
  withinOperatingHours,
  localDayKey,
  daysBetweenDayKeys,
  withinChallengeCooldown,
  challengeBackoffActive,
  passesAutoStartSafety,
  shouldRecoverStalledRun,
  shouldResumeDrain,
  confirmStall,
  shouldSelfReload,
  type AutoStartInput,
  type AutoDrainInput,
  type StalledRunInput,
  type SelfReloadInput,
} from "../src/lib/autonomy.js";

const base: AutoStartInput = {
  autonomous: true,
  runActive: false,
  localHour: 12,
  startHour: 9,
  endHour: 21,
  todayKey: "2026-07-06",
  lastAutoStartDay: null,
};

describe("autonomy", () => {
  it("withinOperatingHours respects the daytime window", () => {
    expect(withinOperatingHours(9, 9, 21)).toBe(true);
    expect(withinOperatingHours(20, 9, 21)).toBe(true);
    expect(withinOperatingHours(21, 9, 21)).toBe(false); // end exclusive
    expect(withinOperatingHours(8, 9, 21)).toBe(false);
    expect(withinOperatingHours(3, 9, 21)).toBe(false);
  });

  it("auto-starts once inside the window when idle and not yet run today", () => {
    expect(shouldAutoStart(base)).toBe(true);
  });

  it("does not auto-start when disabled, running, outside hours, or already run today", () => {
    expect(shouldAutoStart({ ...base, autonomous: false })).toBe(false);
    expect(shouldAutoStart({ ...base, runActive: true })).toBe(false);
    expect(shouldAutoStart({ ...base, localHour: 7 })).toBe(false);
    expect(shouldAutoStart({ ...base, localHour: 23 })).toBe(false);
    expect(shouldAutoStart({ ...base, lastAutoStartDay: "2026-07-06" })).toBe(false);
  });

  it("auto-starts again on a new day", () => {
    expect(shouldAutoStart({ ...base, lastAutoStartDay: "2026-07-05" })).toBe(true);
  });

  it("localDayKey is zero-padded YYYY-MM-DD", () => {
    expect(localDayKey(new Date(2026, 0, 3))).toBe("2026-01-03");
    expect(localDayKey(new Date(2026, 11, 25))).toBe("2026-12-25");
  });
});

describe("daysBetweenDayKeys", () => {
  it("counts UTC calendar days b−a", () => {
    expect(daysBetweenDayKeys("2026-07-06", "2026-07-09")).toBe(3);
    expect(daysBetweenDayKeys("2026-07-09", "2026-07-09")).toBe(0);
  });
  it("is NaN for a malformed key", () => {
    expect(Number.isNaN(daysBetweenDayKeys("garbage", "2026-07-09"))).toBe(true);
    expect(Number.isNaN(daysBetweenDayKeys("2026-07-09", "nope"))).toBe(true);
  });
});

describe("withinChallengeCooldown", () => {
  it("is false with no recorded challenge", () => {
    expect(withinChallengeCooldown("2026-07-06", null, 3)).toBe(false);
  });
  it("is true on the challenge day itself", () => {
    expect(withinChallengeCooldown("2026-07-06", "2026-07-06", 3)).toBe(true);
  });
  it("clears exactly at cooldownDays (exclusive edge)", () => {
    expect(withinChallengeCooldown("2026-07-09", "2026-07-06", 3)).toBe(false); // diff 3 == cooldown
    expect(withinChallengeCooldown("2026-07-08", "2026-07-06", 3)).toBe(true); // diff 2 < 3
  });
  it("is false when cooldown is disabled (<=0)", () => {
    expect(withinChallengeCooldown("2026-07-06", "2026-07-06", 0)).toBe(false);
  });
  it("fails closed on a malformed key (→ true)", () => {
    expect(withinChallengeCooldown("2026-07-06", "garbage", 3)).toBe(true);
  });
  it("fails closed on clock skew (today before last → true)", () => {
    expect(withinChallengeCooldown("2026-07-06", "2026-07-10", 3)).toBe(true);
  });
});

describe("challengeBackoffActive", () => {
  it("is false with no challenge recorded", () => {
    expect(challengeBackoffActive(null, "2026-07-06", 3)).toBe(false);
  });
  it("is true within the backoff window", () => {
    expect(challengeBackoffActive("2026-07-05", "2026-07-06", 3)).toBe(true); // 1 day ago
    expect(challengeBackoffActive("2026-07-04", "2026-07-06", 3)).toBe(true); // diff 2
    expect(challengeBackoffActive("2026-07-06", "2026-07-06", 3)).toBe(true); // same day
  });
  it("pins the exclusive edge", () => {
    expect(challengeBackoffActive("2026-07-03", "2026-07-06", 3)).toBe(false); // diff 3 == backoff → cleared
  });
  it("is false once expired", () => {
    expect(challengeBackoffActive("2026-07-01", "2026-07-06", 3)).toBe(false); // 5 days ago
  });
  it("is false when the flag is off (0)", () => {
    expect(challengeBackoffActive("2026-07-05", "2026-07-06", 0)).toBe(false);
  });
  it("fails closed on an unparseable key (→ true)", () => {
    expect(challengeBackoffActive("garbage", "2026-07-06", 3)).toBe(true);
  });
  it("fails closed on clock skew (future stamp → true)", () => {
    expect(challengeBackoffActive("2026-07-10", "2026-07-06", 3)).toBe(true);
  });
});

describe("shouldAutoStart challenge backoff integration", () => {
  it("suppresses auto-start while within the backoff window", () => {
    expect(shouldAutoStart({ ...base, lastChallengeDay: "2026-07-05", challengeBackoffDays: 3 })).toBe(false);
  });
  it("is unchanged when the backoff flag is off", () => {
    expect(shouldAutoStart({ ...base, lastChallengeDay: "2026-07-05", challengeBackoffDays: 0 })).toBe(true);
  });
  it("auto-starts once the backoff expires", () => {
    expect(shouldAutoStart({ ...base, lastChallengeDay: "2026-06-01", challengeBackoffDays: 3 })).toBe(true);
  });
  it("is byte-identical to today when the new fields are absent (default OFF)", () => {
    expect(shouldAutoStart({ ...base })).toBe(true);
  });
});

describe("passesAutoStartSafety", () => {
  const ok = {
    healthGate: true,
    healthStatus: "ok" as const,
    challengeCooldownDays: 3,
    todayKey: "2026-07-09",
    lastChallengeDay: null,
  };
  it("passes when health is ok and no cooldown active", () => {
    expect(passesAutoStartSafety(ok)).toBe(true);
  });
  it("skips on non-ok health when the gate is on", () => {
    expect(passesAutoStartSafety({ ...ok, healthStatus: "warn" })).toBe(false);
    expect(passesAutoStartSafety({ ...ok, healthStatus: "halt" })).toBe(false);
  });
  it("fails closed on unknown health (fetch failed → null) when the gate is on", () => {
    expect(passesAutoStartSafety({ ...ok, healthStatus: null })).toBe(false);
  });
  it("allows unknown health when the gate is off", () => {
    expect(passesAutoStartSafety({ ...ok, healthGate: false, healthStatus: null })).toBe(true);
  });
  it("cooldown wins even when health is ok", () => {
    expect(passesAutoStartSafety({ ...ok, lastChallengeDay: "2026-07-08" })).toBe(false); // diff 1 < 3
  });
});

describe("shouldAutoDrain", () => {
  const drainBase: AutoDrainInput = {
    autonomous: true,
    autoDrain: true,
    runActive: false,
    localHour: 15,
    startHour: 9,
    endHour: 21,
    pendingComments: 12,
    lastAutoDrainMs: null,
    nowMs: 1_000_000_000,
    minGapMinutes: 30,
    todayKey: "2026-07-17",
    stopDay: null,
  };

  it("drains when supply exists, idle, in window", () => {
    expect(shouldAutoDrain(drainBase)).toBe(true);
  });

  it("is NOT once-per-day: fires again after the re-arm gap", () => {
    const gapMs = 31 * 60_000;
    expect(shouldAutoDrain({ ...drainBase, lastAutoDrainMs: drainBase.nowMs - gapMs })).toBe(true);
  });

  it("respects the re-arm cooldown", () => {
    const gapMs = 29 * 60_000;
    expect(shouldAutoDrain({ ...drainBase, lastAutoDrainMs: drainBase.nowMs - gapMs })).toBe(false);
  });

  it("does not drain when disabled, running, out of window, or empty", () => {
    expect(shouldAutoDrain({ ...drainBase, autonomous: false })).toBe(false);
    expect(shouldAutoDrain({ ...drainBase, autoDrain: false })).toBe(false);
    expect(shouldAutoDrain({ ...drainBase, runActive: true })).toBe(false);
    expect(shouldAutoDrain({ ...drainBase, localHour: 8 })).toBe(false);
    expect(shouldAutoDrain({ ...drainBase, localHour: 21 })).toBe(false); // end exclusive
    expect(shouldAutoDrain({ ...drainBase, pendingComments: 0 })).toBe(false);
  });

