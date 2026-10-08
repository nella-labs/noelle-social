import { describe, expect, it } from "vitest";
import { computeComposeSlots } from "./content-slots.js";

describe("computeComposeSlots", () => {
  it("produces perDay * days slot times", () => {
    const slots = computeComposeSlots({ startDate: "2026-06-22", days: 14, perDay: 7, windowsUtc: [14, 17, 21] });
    expect(slots).toHaveLength(98);
  });

  it("uses the exact configured windows when perDay <= windows", () => {
    const slots = computeComposeSlots({ startDate: "2026-06-22", days: 2, perDay: 3, windowsUtc: [14, 17, 21] });
    expect(slots.slice(0, 3)).toEqual([
      "2026-06-22T14:00:00Z",
      "2026-06-22T17:00:00Z",
      "2026-06-22T21:00:00Z",
    ]);
    expect(slots[3]).toBe("2026-06-23T14:00:00Z"); // next day rolls over
  });

  it("is strictly ascending across days and within a day", () => {
    const slots = computeComposeSlots({ startDate: "2026-06-22", days: 5, perDay: 9, windowsUtc: [14, 17, 21] });
    for (let i = 1; i < slots.length; i++) {
      expect(slots[i]! > slots[i - 1]!).toBe(true);
    }
  });

  it("spreads across the day (still inside the window span) when perDay > windows", () => {
    const slots = computeComposeSlots({ startDate: "2026-06-22", days: 1, perDay: 5, windowsUtc: [14, 21] });
    expect(slots).toHaveLength(5);
    expect(slots.every((s) => s.startsWith("2026-06-22T"))).toBe(true);
    expect(slots[0]!.slice(11, 13)).toBe("14"); // first at the earliest window
    expect(slots[4]!.slice(11, 13)).toBe("21"); // last at the latest window
  });
});
