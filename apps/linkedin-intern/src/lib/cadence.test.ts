import { describe, expect, it } from "vitest";
import { withinActiveHours } from "./cadence.js";

// Bogota is UTC-5 (offset -300). Pick UTC instants and check the local-hour gate.
const bogota = (start: number, end: number) => ({
  LINKEDIN_ACTIVE_HOURS_START: start,
  LINKEDIN_ACTIVE_HOURS_END: end,
  LINKEDIN_TZ_OFFSET_MIN: -300,
});

describe("withinActiveHours", () => {
  it("is false outside the daytime window (3am Bogota)", () => {
    // 08:00Z = 03:00 Bogota
    expect(withinActiveHours(bogota(7, 23), Date.UTC(2026, 5, 8, 8, 0, 0))).toBe(false);
  });

  it("is true inside the daytime window (noon Bogota)", () => {
    // 17:00Z = 12:00 Bogota
    expect(withinActiveHours(bogota(7, 23), Date.UTC(2026, 5, 8, 17, 0, 0))).toBe(true);
  });

  it("handles a window that wraps past midnight", () => {
    // 04:00Z (next day) = 23:00 Bogota -> inside 22..6
    expect(withinActiveHours(bogota(22, 6), Date.UTC(2026, 5, 9, 4, 0, 0))).toBe(true);
    // 17:00Z = 12:00 Bogota -> outside 22..6
    expect(withinActiveHours(bogota(22, 6), Date.UTC(2026, 5, 8, 17, 0, 0))).toBe(false);
  });

  it("runs 24h when start == end (gate disabled)", () => {
    expect(withinActiveHours(bogota(9, 9), Date.UTC(2026, 5, 8, 8, 0, 0))).toBe(true);
  });
});
