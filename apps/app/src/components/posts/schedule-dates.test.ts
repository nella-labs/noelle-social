import { describe, expect, it } from "vitest";
import {
  addDays,
  addMonths,
  dayOfMonth,
  isSameMonth,
  monthLabel,
  monthMatrix,
  startOfWeekMonday,
  WEEKDAY_SHORT,
  weekDays,
} from "./schedule-dates";

// Anchor facts: 2026-06-22 is a Monday; June 2026 starts on a Monday and has 30 days.
describe("schedule-dates", () => {
  it("addDays rolls over months and years (UTC-stable)", () => {
    expect(addDays("2026-06-30", 1)).toBe("2026-07-01");
    expect(addDays("2026-06-22", -1)).toBe("2026-06-21");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2026-06-22", 7)).toBe("2026-06-29");
  });

  it("startOfWeekMonday snaps any day to its Monday", () => {
    expect(startOfWeekMonday("2026-06-22")).toBe("2026-06-22"); // already Monday
    expect(startOfWeekMonday("2026-06-24")).toBe("2026-06-22"); // Wed -> Mon
    expect(startOfWeekMonday("2026-06-28")).toBe("2026-06-22"); // Sun -> Mon
    expect(startOfWeekMonday("2026-06-30")).toBe("2026-06-29"); // Tue -> Mon
  });

  it("weekDays returns Mon..Sun for the anchor's week", () => {
    expect(weekDays("2026-06-24")).toEqual([
      "2026-06-22", "2026-06-23", "2026-06-24", "2026-06-25",
      "2026-06-26", "2026-06-27", "2026-06-28",
    ]);
  });

  it("monthMatrix covers the whole month padded to full Mon-start weeks", () => {
    const m = monthMatrix("2026-06-15");
    expect(m).toHaveLength(5);
    expect(m[0]?.[0]).toBe("2026-06-01"); // first cell = Mon Jun 1
    expect(m[0]).toHaveLength(7);
    expect(m[4]?.[6]).toBe("2026-07-05"); // last cell trails into July
    expect(m.flat()).toHaveLength(35);
  });

  it("isSameMonth compares the year+month only", () => {
    expect(isSameMonth("2026-06-30", "2026-06-15")).toBe(true);
    expect(isSameMonth("2026-07-01", "2026-06-15")).toBe(false);
    expect(isSameMonth("2025-06-15", "2026-06-15")).toBe(false);
  });

  it("addMonths clamps the day to the target month's length", () => {
    expect(addMonths("2026-06-30", 1)).toBe("2026-07-30");
    expect(addMonths("2026-01-31", 1)).toBe("2026-02-28"); // Feb clamp
    expect(addMonths("2026-12-15", 1)).toBe("2027-01-15"); // year roll
    expect(addMonths("2026-03-31", -1)).toBe("2026-02-28");
  });

  it("formats labels", () => {
    expect(monthLabel("2026-06-15")).toBe("June 2026");
    expect(dayOfMonth("2026-06-22")).toBe(22);
    expect(WEEKDAY_SHORT).toEqual(["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"]);
  });
});
