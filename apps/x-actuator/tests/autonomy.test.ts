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

  it("a manual STOP silences it for the rest of that day only", () => {
    expect(shouldAutoDrain({ ...drainBase, stopDay: "2026-07-17" })).toBe(false);
    expect(shouldAutoDrain({ ...drainBase, stopDay: "2026-07-16" })).toBe(true);
  });

  it("fails closed on a skewed/garbage re-arm stamp", () => {
    expect(shouldAutoDrain({ ...drainBase, lastAutoDrainMs: drainBase.nowMs + 60_000 })).toBe(false); // future stamp
    expect(shouldAutoDrain({ ...drainBase, lastAutoDrainMs: Number.NaN })).toBe(false);
  });
});

describe("shouldRecoverStalledRun", () => {
  // A run that is running, past warm-up, has drafts loaded and overdue comment
  // slots, and hasn't posted in 25 min (> the 20-min threshold) → wedged.
  const stalledBase: StalledRunInput = {
    autonomous: true,
    autoDrain: true,
    runActive: true,
    msSinceProgress: 25 * 60_000,
    msSinceStart: 40 * 60_000,
    warmupSuppressMs: 4 * 60_000,
    stallThresholdMs: 20 * 60_000,
    loadedDrafts: 6,
    dueCommentSlots: 3,
    localHour: 15,
    startHour: 9,
    endHour: 21,
    lastAutoDrainMs: null,
    nowMs: 1_000_000_000,
    minGapMinutes: 30,
    todayKey: "2026-07-19",
    stopDay: null,
  };

  it("recovers a provably wedged run", () => {
    expect(shouldRecoverStalledRun(stalledBase)).toBe(true);
  });

  it("does NOT fire on a healthy run that posted recently", () => {
    expect(shouldRecoverStalledRun({ ...stalledBase, msSinceProgress: 19 * 60_000 })).toBe(false); // under threshold
  });

  it("does NOT fire when idle-waiting for supply (nothing loaded)", () => {
    expect(shouldRecoverStalledRun({ ...stalledBase, loadedDrafts: 0 })).toBe(false);
  });

  it("does NOT fire when correctly paced (no overdue comment slots)", () => {
    expect(shouldRecoverStalledRun({ ...stalledBase, dueCommentSlots: 0 })).toBe(false);
  });

  it("does NOT fire while still in warm-up", () => {
    // msSinceStart inside the warm-up window, even though progress looks stale.
    expect(shouldRecoverStalledRun({ ...stalledBase, msSinceStart: 3 * 60_000, warmupSuppressMs: 4 * 60_000 })).toBe(false);
  });

  it("only ever supersedes a LIVE run", () => {
    expect(shouldRecoverStalledRun({ ...stalledBase, runActive: false })).toBe(false);
  });

  it("respects the opt-ins and the operating window", () => {
    expect(shouldRecoverStalledRun({ ...stalledBase, autonomous: false })).toBe(false);
    expect(shouldRecoverStalledRun({ ...stalledBase, autoDrain: false })).toBe(false);
    expect(shouldRecoverStalledRun({ ...stalledBase, localHour: 8 })).toBe(false);
    expect(shouldRecoverStalledRun({ ...stalledBase, localHour: 21 })).toBe(false); // end exclusive
  });

  it("shares the auto-drain re-arm cooldown (can't machine-gun)", () => {
    expect(shouldRecoverStalledRun({ ...stalledBase, lastAutoDrainMs: stalledBase.nowMs - 29 * 60_000 })).toBe(false); // within cooldown
    expect(shouldRecoverStalledRun({ ...stalledBase, lastAutoDrainMs: stalledBase.nowMs - 31 * 60_000 })).toBe(true);  // cooldown elapsed
  });

  it("a manual STOP silences recovery for the rest of that day", () => {
    expect(shouldRecoverStalledRun({ ...stalledBase, stopDay: "2026-07-19" })).toBe(false);
    expect(shouldRecoverStalledRun({ ...stalledBase, stopDay: "2026-07-18" })).toBe(true);
  });

  it("fails closed on a skewed/garbage re-arm stamp", () => {
    expect(shouldRecoverStalledRun({ ...stalledBase, lastAutoDrainMs: stalledBase.nowMs + 60_000 })).toBe(false); // future
    expect(shouldRecoverStalledRun({ ...stalledBase, lastAutoDrainMs: Number.NaN })).toBe(false);
  });
});

describe("confirmStall (two-tick confirmation)", () => {
  const sid = "sess-1";
  it("observes on the first stalled sighting (no probe yet)", () => {
    expect(confirmStall({ stalledNow: true, sessionId: sid, progressMs: 1000, probe: null })).toBe("observe");
  });
  it("recovers only when stalled twice with the same run + unchanged progress", () => {
    expect(confirmStall({ stalledNow: true, sessionId: sid, progressMs: 1000, probe: { sid, progressMs: 1000 } })).toBe("recover");
  });
  it("re-observes (never recovers) when progress advanced — a healthy run posted between ticks", () => {
    expect(confirmStall({ stalledNow: true, sessionId: sid, progressMs: 2000, probe: { sid, progressMs: 1000 } })).toBe("observe");
  });
  it("re-observes when the probe belongs to a superseded run (different session)", () => {
    expect(confirmStall({ stalledNow: true, sessionId: "sess-2", progressMs: 1000, probe: { sid, progressMs: 1000 } })).toBe("observe");
  });
  it("clears the probe the moment the run is no longer stalled", () => {
    expect(confirmStall({ stalledNow: false, sessionId: sid, progressMs: 1000, probe: { sid, progressMs: 1000 } })).toBe("clear");
    expect(confirmStall({ stalledNow: false, sessionId: sid, progressMs: 1000, probe: null })).toBe("clear");
  });
});
describe("shouldSelfReload", () => {
  const reloadBase: SelfReloadInput = {
    runActive: false,
    embeddedStamp: "2026-07-17T16:00:00.000Z",
    servedStamp: "2026-07-17T17:00:00.000Z",
    lastAttemptedStamp: null,
  };

  it("reloads when idle and a newer build is on disk", () => {
    expect(shouldSelfReload(reloadBase)).toBe(true);
  });

  it("never reloads during a run", () => {
    expect(shouldSelfReload({ ...reloadBase, runActive: true })).toBe(false);
  });

  it("does nothing when already running the on-disk build", () => {
    expect(shouldSelfReload({ ...reloadBase, servedStamp: reloadBase.embeddedStamp })).toBe(false);
  });

  it("fails closed when either stamp is unknown", () => {
    expect(shouldSelfReload({ ...reloadBase, servedStamp: null })).toBe(false);
    expect(shouldSelfReload({ ...reloadBase, embeddedStamp: null })).toBe(false);
  });

  it("attempts once per served stamp (a stale disk copy cannot loop)", () => {
    expect(shouldSelfReload({ ...reloadBase, lastAttemptedStamp: reloadBase.servedStamp })).toBe(false);
    expect(shouldSelfReload({ ...reloadBase, lastAttemptedStamp: "2026-07-16T09:00:00.000Z" })).toBe(true);
  });

  it("MAY reload a live-but-resumable run (persistent drain that will self-resume)", () => {
    // The #488 fix: a persistent drain never ends, so `runActive` alone would pin
    // the extension on a stale build forever. When a resume path will bring it
    // back (Full-auto intent / auto-drain), a reload is allowed so the self-update
    // completes instead of silently stopping the run.
    expect(shouldSelfReload({ ...reloadBase, runActive: true, runResumable: true })).toBe(true);
    // still never interrupts a BUSY run (not resumable this instant).
    expect(shouldSelfReload({ ...reloadBase, runActive: true, runResumable: false })).toBe(false);
  });
});

describe("shouldResumeDrain", () => {
  const base = { intentSet: true, runActive: false, safe: true };

  it("resumes when the standing intent is set, nothing runs, and it is safe", () => {
    expect(shouldResumeDrain(base)).toBe(true);
  });

  it("does nothing without the durable intent (never auto-starts on its own)", () => {
    expect(shouldResumeDrain({ ...base, intentSet: false })).toBe(false);
  });

  it("never starts a second overlapping run", () => {
    expect(shouldResumeDrain({ ...base, runActive: true })).toBe(false);
  });

  it("holds off when the safety gate fails (post-challenge cooldown / bad health) — resumes later, no re-click", () => {
    expect(shouldResumeDrain({ ...base, safe: false })).toBe(false);
  });
});
