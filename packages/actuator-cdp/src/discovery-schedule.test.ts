import { describe, expect, it } from "vitest";
import {
  DEFAULT_DISCOVERY_SCHEDULE,
  isDiscoveryQuietTime,
  parseDiscoverySchedule,
} from "./discovery-schedule.js";

describe("browser discovery quiet hours", () => {
  it("runs 24/7 unless a quiet window is enabled", () => {
    expect(parseDiscoverySchedule(undefined)).toEqual(DEFAULT_DISCOVERY_SCHEDULE);
    expect(isDiscoveryQuietTime(Date.parse("2026-09-20T03:00:00"), DEFAULT_DISCOVERY_SCHEDULE)).toBe(false);
  });

  it("uses local start-inclusive and end-exclusive minute boundaries", () => {
    const schedule = { enabled: true, start: "01:00", end: "09:00" };
    const local = (hour: number, minute: number) => new Date(2026, 8, 20, hour, minute).getTime();
    expect(isDiscoveryQuietTime(local(0, 59), schedule)).toBe(false);
    expect(isDiscoveryQuietTime(local(1, 0), schedule)).toBe(true);
    expect(isDiscoveryQuietTime(local(8, 59), schedule)).toBe(true);
    expect(isDiscoveryQuietTime(local(9, 0), schedule)).toBe(false);
  });

  it("supports a window that crosses midnight", () => {
    const schedule = { enabled: true, start: "23:30", end: "06:15" };
    const local = (hour: number, minute: number) => new Date(2026, 8, 20, hour, minute).getTime();
    expect(isDiscoveryQuietTime(local(23, 30), schedule)).toBe(true);
    expect(isDiscoveryQuietTime(local(2, 0), schedule)).toBe(true);
    expect(isDiscoveryQuietTime(local(6, 15), schedule)).toBe(false);
    expect(isDiscoveryQuietTime(local(12, 0), schedule)).toBe(false);
  });

  it("rejects malformed or all-day quiet windows rather than silently pausing forever", () => {
    expect(parseDiscoverySchedule({ enabled: true, start: "99:00", end: "09:00" })).toEqual(DEFAULT_DISCOVERY_SCHEDULE);
    expect(parseDiscoverySchedule({ enabled: true, start: "01:00", end: "01:00" })).toEqual(DEFAULT_DISCOVERY_SCHEDULE);
  });
});
