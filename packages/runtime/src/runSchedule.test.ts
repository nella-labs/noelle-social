import { describe, expect, it } from "vitest";
import type { RunSchedule } from "@noelle/contracts";
import { computeNextRunAt, planScheduledRun, BUSY_RETRY_MS } from "./runSchedule.js";

const interval = (intervalHours: number, extra: Partial<RunSchedule> = {}): RunSchedule => ({
  enabled: true,
  mode: "interval",
  intervalHours,
  timezone: "UTC",
  goal: 20,
  ...extra,
});
const daily = (dailyTime: string, timezone: string, extra: Partial<RunSchedule> = {}): RunSchedule => ({
  enabled: true,
  mode: "daily",
  dailyTime,
  timezone,
  goal: 20,
  ...extra,
});

describe("computeNextRunAt — interval", () => {
  it("adds intervalHours to `from`", () => {
    const next = computeNextRunAt(interval(6), new Date("2026-07-12T10:00:00Z"));
    expect(next?.toISOString()).toBe("2026-07-12T16:00:00.000Z");
  });
});

describe("computeNextRunAt — daily", () => {
  it("returns today's HH:MM when it is still upcoming (UTC)", () => {
    const next = computeNextRunAt(daily("09:00", "UTC"), new Date("2026-07-12T08:00:00Z"));
    expect(next?.toISOString()).toBe("2026-07-12T09:00:00.000Z");
  });

  it("rolls to tomorrow when today's HH:MM already passed (UTC)", () => {
    const next = computeNextRunAt(daily("09:00", "UTC"), new Date("2026-07-12T10:00:00Z"));
    expect(next?.toISOString()).toBe("2026-07-13T09:00:00.000Z");
  });

  it("interprets HH:MM in the schedule timezone, not UTC (Bogota, UTC-5)", () => {
    // 09:00 Bogota == 14:00 UTC. `from` 12:00Z is 07:00 local → still upcoming.
    const next = computeNextRunAt(daily("09:00", "America/Bogota"), new Date("2026-07-12T12:00:00Z"));
    expect(next?.toISOString()).toBe("2026-07-12T14:00:00.000Z");
  });

  it("rolls to tomorrow in a non-UTC tz once local time passes (Bogota)", () => {
    // `from` 15:00Z is 10:00 local, past 09:00 → next is tomorrow 09:00 local = 14:00Z.
    const next = computeNextRunAt(daily("09:00", "America/Bogota"), new Date("2026-07-12T15:00:00Z"));
    expect(next?.toISOString()).toBe("2026-07-13T14:00:00.000Z");
  });

  it("uses the correct offset in summer DST (New York EDT, UTC-4)", () => {
    // 09:00 America/New_York in July is EDT (UTC-4) → 13:00Z.
    const next = computeNextRunAt(daily("09:00", "America/New_York"), new Date("2026-07-12T05:00:00Z"));
    expect(next?.toISOString()).toBe("2026-07-12T13:00:00.000Z");
  });

  it("uses the correct offset in winter (New York EST, UTC-5)", () => {
    // 09:00 America/New_York in January is EST (UTC-5) → 14:00Z.
    const next = computeNextRunAt(daily("09:00", "America/New_York"), new Date("2026-01-12T05:00:00Z"));
    expect(next?.toISOString()).toBe("2026-01-12T14:00:00.000Z");
  });

  it("handles the day AFTER the US spring-forward transition (2026-03-08 → EDT)", () => {
    // On 2026-03-08 NY jumps 02:00 EST → 03:00 EDT. 09:00 that day is EDT → 13:00Z.
    const next = computeNextRunAt(daily("09:00", "America/New_York"), new Date("2026-03-08T05:00:00Z"));
    expect(next?.toISOString()).toBe("2026-03-08T13:00:00.000Z");
  });
});

describe("computeNextRunAt — unfireable", () => {
  it("returns null when disabled", () => {
    expect(computeNextRunAt(interval(6, { enabled: false }), new Date())).toBeNull();
  });

  it("returns null for interval mode missing intervalHours", () => {
    const bad = { enabled: true, mode: "interval", timezone: "UTC", goal: 20 } as RunSchedule;
    expect(computeNextRunAt(bad, new Date())).toBeNull();
  });

  it("returns null for daily mode missing dailyTime", () => {
    const bad = { enabled: true, mode: "daily", timezone: "UTC", goal: 20 } as RunSchedule;
    expect(computeNextRunAt(bad, new Date())).toBeNull();
  });
});

describe("planScheduledRun", () => {
  const now = new Date("2026-07-12T10:00:00Z");

  it("clears when there is no schedule", () => {
    expect(planScheduledRun({ runSchedule: null, goalActive: false }, now)).toEqual({ action: "clear" });
  });

  it("clears when the schedule is disabled", () => {
    const plan = planScheduledRun({ runSchedule: interval(6, { enabled: false }), goalActive: false }, now);
    expect(plan).toEqual({ action: "clear" });
  });

  it("fires when idle, carrying the goal and a fresh next_at", () => {
    const plan = planScheduledRun({ runSchedule: interval(6), goalActive: false }, now);
    expect(plan.action).toBe("fire");
    if (plan.action === "fire") {
      expect(plan.goal).toBe(20);
      expect(plan.nextAt?.toISOString()).toBe("2026-07-12T16:00:00.000Z");
    }
  });

  it("never stomps an active run, and DEFERS ~30min instead of losing the day", () => {
    // The old behaviour rolled next_at to the next occurrence, which silently
    // dropped the whole day. Measured on Lyra: exactly ONE of her scheduled
    // 08:00 runs fired in six weeks, because her runs habitually spill past
    // 08:00 and every one of those days was skipped outright.
    const plan = planScheduledRun({ runSchedule: interval(6), goalActive: true }, now);
    expect(plan.action).toBe("skip");
    if (plan.action === "skip") {
      expect(plan.nextAt?.toISOString()).toBe(
        new Date(now.getTime() + BUSY_RETRY_MS).toISOString(),
      );
      // …and crucially NOT the next scheduled occurrence.
      expect(plan.nextAt?.toISOString()).not.toBe("2026-07-12T16:00:00.000Z");
    }
  });

  it("never defers past local midnight, so the chain cannot cross into the night", () => {
    // The first version of this test used interval(6), where the next
    // occurrence is always now+6h — so retryAt (now+30m) could never reach the
    // cap and BOTH assertions passed with the cap deleted. It was vacuous.
    //
    // A DAILY schedule is the case that matters: its next occurrence is
    // TOMORROW, so capping at "next occurrence" would happily defer a busy
    // 08:00 slot to 00:20 — the exact overnight hours the curfew tightens.
    const daily: RunSchedule = {
      enabled: true,
      mode: "daily",
      dailyTime: "08:00",
      timezone: "UTC",
      intervalHours: null,
      goal: 90,
    };
    // 23:50 local: now + 30min lands at 00:20 TOMORROW.
    const lateNight = new Date("2026-07-12T23:50:00Z");
    const plan = planScheduledRun({ runSchedule: daily, goalActive: true }, lateNight);
    expect(plan.action).toBe("skip");
    if (plan.action === "skip") {
      // The day is over: hand it back to the normal schedule rather than
      // deferring into the small hours — tomorrow's slot, not 00:20.
      // The retry cap and the next occurrence both use the schedule's UTC day.
      expect(plan.nextAt!.getUTCHours()).toBe(8);
      expect(plan.nextAt!.getTime()).toBeGreaterThan(lateNight.getTime());
      // …and decisively NOT the 30-minute retry, which would land at 00:20.
      expect(plan.nextAt!.getTime()).not.toBe(lateNight.getTime() + BUSY_RETRY_MS);
    }
  });

  it("ends the retry chain at the schedule's midnight before UTC midnight", () => {
    const now = new Date("2026-07-13T04:45:00Z"); // Bogota: July 12, 23:45.
    const plan = planScheduledRun({
      runSchedule: daily("08:00", "America/Bogota"), goalActive: true,
    }, now);
    expect(plan).toEqual({ action: "skip", nextAt: new Date("2026-07-13T13:00:00Z") });
  });

  it("keeps a retry that crosses UTC midnight within the schedule's day", () => {
    const now = new Date("2026-07-12T23:45:00Z"); // Bogota: July 12, 18:45.
    const plan = planScheduledRun({
      runSchedule: daily("08:00", "America/Bogota"), goalActive: true,
    }, now);
    expect(plan).toEqual({ action: "skip", nextAt: new Date("2026-07-13T00:15:00Z") });
  });

  it.each([
    ["2026-12-31T23:45:00Z", "UTC", "2027-01-01T08:00:00Z"],
    ["2026-03-09T03:45:00Z", "America/New_York", "2026-03-09T12:00:00Z"],
    ["2026-11-02T04:45:00Z", "America/New_York", "2026-11-02T13:00:00Z"],
  ])("uses the calendar midnight across year and DST changes (%s)", (at, timezone, next) => {
    const plan = planScheduledRun({ runSchedule: daily("08:00", timezone), goalActive: true }, new Date(at));
    expect(plan).toEqual({ action: "skip", nextAt: new Date(next) });
  });

  it("uses the plain 30-minute retry when it comfortably fits the day", () => {
    const daily: RunSchedule = {
      enabled: true,
      mode: "daily",
      dailyTime: "08:00",
      timezone: "UTC",
      intervalHours: null,
      goal: 90,
    };
    const midMorning = new Date("2026-07-12T08:05:00Z");
    const plan = planScheduledRun({ runSchedule: daily, goalActive: true }, midMorning);
    expect(plan.action).toBe("skip");
    if (plan.action === "skip") {
      expect(plan.nextAt!.getTime()).toBe(midMorning.getTime() + BUSY_RETRY_MS);
    }
  });

  it("an IDLE row still fires immediately — the defer only applies when busy", () => {
    const plan = planScheduledRun({ runSchedule: interval(6), goalActive: false }, now);
    expect(plan.action).toBe("fire");
  });
});
