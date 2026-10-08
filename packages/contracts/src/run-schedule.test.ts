import { describe, expect, it } from "vitest";
import { RunScheduleSchema, parseRunSchedule } from "./run-schedule.js";

describe("RunScheduleSchema", () => {
  it("accepts a valid interval schedule", () => {
    const res = RunScheduleSchema.safeParse({
      enabled: true,
      mode: "interval",
      intervalHours: 6,
      timezone: "America/Bogota",
      goal: 20,
    });
    expect(res.success).toBe(true);
  });

  it("accepts a valid daily schedule", () => {
    const res = RunScheduleSchema.safeParse({
      enabled: true,
      mode: "daily",
      dailyTime: "09:00",
      timezone: "America/Bogota",
      goal: 20,
    });
    expect(res.success).toBe(true);
  });

  it("rejects interval mode without intervalHours", () => {
    const res = RunScheduleSchema.safeParse({
      enabled: true,
      mode: "interval",
      timezone: "UTC",
      goal: 20,
    });
    expect(res.success).toBe(false);
  });

  it("rejects daily mode without dailyTime", () => {
    const res = RunScheduleSchema.safeParse({
      enabled: true,
      mode: "daily",
      timezone: "UTC",
      goal: 20,
    });
    expect(res.success).toBe(false);
  });

  it("rejects a malformed dailyTime", () => {
    for (const dailyTime of ["9:00", "24:00", "09:60", "0900", "noon"]) {
      const res = RunScheduleSchema.safeParse({
        enabled: true,
        mode: "daily",
        dailyTime,
        timezone: "UTC",
        goal: 20,
      });
      expect(res.success, dailyTime).toBe(false);
    }
  });

  it("enforces goal bounds (1..500)", () => {
    for (const goal of [0, -5, 501, 1000]) {
      const res = RunScheduleSchema.safeParse({
        enabled: true,
        mode: "interval",
        intervalHours: 6,
        timezone: "UTC",
        goal,
      });
      expect(res.success, String(goal)).toBe(false);
    }
  });

  it("enforces intervalHours bounds (1..168)", () => {
    for (const intervalHours of [0, 169, 999]) {
      const res = RunScheduleSchema.safeParse({
        enabled: true,
        mode: "interval",
        intervalHours,
        timezone: "UTC",
        goal: 20,
      });
      expect(res.success, String(intervalHours)).toBe(false);
    }
  });

  it("rejects unknown keys (strict)", () => {
    const res = RunScheduleSchema.safeParse({
      enabled: true,
      mode: "interval",
      intervalHours: 6,
      timezone: "UTC",
      goal: 20,
      surprise: true,
    });
    expect(res.success).toBe(false);
  });
});

describe("parseRunSchedule", () => {
  it("returns null for null/empty/garbage", () => {
    expect(parseRunSchedule(null)).toBeNull();
    expect(parseRunSchedule(undefined)).toBeNull();
    expect(parseRunSchedule("nope")).toBeNull();
    expect(parseRunSchedule({})).toBeNull();
    expect(parseRunSchedule({ mode: "daily" })).toBeNull();
  });

  it("round-trips a valid schedule", () => {
    const schedule = {
      enabled: true,
      mode: "daily" as const,
      dailyTime: "09:00",
      timezone: "America/Bogota",
      goal: 20,
    };
    expect(parseRunSchedule(schedule)).toEqual(schedule);
  });

  it("self-heals a legacy double-encoded jsonb string", () => {
    // Reproduces the bug: `${JSON.stringify(schedule)}::jsonb` stored a jsonb
    // *string*, which postgres.js reads back as a JS string rather than an
    // object. The panel + scheduler must still recover the schedule from it.
    const schedule = {
      enabled: true,
      mode: "daily" as const,
      intervalHours: null,
      dailyTime: "09:00",
      timezone: "America/Bogota",
      goal: 90,
    };
    const doubleEncoded = JSON.stringify(schedule); // the JS string a corrupted row yields
    expect(typeof doubleEncoded).toBe("string");
    expect(parseRunSchedule(doubleEncoded)).toEqual(schedule);
  });

  it("returns null for a string that is not JSON", () => {
    expect(parseRunSchedule("{not json")).toBeNull();
  });
});
