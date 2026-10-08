import { describe, expect, it } from "vitest";
import { quietHoldEndMs } from "./quiet-window";

describe("quietHoldEndMs", () => {
  it("returns null outside the quiet window", () => {
    const now = Date.UTC(2026, 5, 8, 14, 0, 0); // 14:00 UTC — outside [4,12)
    expect(quietHoldEndMs(now, { startHourUtc: 4, endHourUtc: 12 })).toBeNull();
  });

  it("returns the next 12:00:00Z when now is inside the overnight window", () => {
    const now = Date.UTC(2026, 5, 8, 6, 0, 0); // 06:00 UTC — inside [4,12)
    const end = quietHoldEndMs(now, { startHourUtc: 4, endHourUtc: 12 });
    expect(end).toBe(Date.UTC(2026, 5, 8, 12, 0, 0));
  });

  it("holds until the boundary even one minute before the window ends", () => {
    const now = Date.UTC(2026, 5, 8, 11, 59, 0);
    expect(quietHoldEndMs(now, { startHourUtc: 4, endHourUtc: 12 })).toBe(
      Date.UTC(2026, 5, 8, 12, 0, 0),
    );
  });

  it("handles a wrapping window (start=22, end=6): inside at 23:00Z and 03:00Z", () => {
    // 23:00Z is after the 22:00 start → holds until 06:00 the NEXT day.
    const late = Date.UTC(2026, 5, 8, 23, 0, 0);
    expect(quietHoldEndMs(late, { startHourUtc: 22, endHourUtc: 6 })).toBe(
      Date.UTC(2026, 5, 9, 6, 0, 0),
    );
    // 03:00Z is before the 06:00 end → holds until 06:00 the SAME day.
    const early = Date.UTC(2026, 5, 8, 3, 0, 0);
    expect(quietHoldEndMs(early, { startHourUtc: 22, endHourUtc: 6 })).toBe(
      Date.UTC(2026, 5, 8, 6, 0, 0),
    );
  });

  it("is null just outside a wrapping window (e.g. 12:00Z for [22,6))", () => {
    const now = Date.UTC(2026, 5, 8, 12, 0, 0);
    expect(quietHoldEndMs(now, { startHourUtc: 22, endHourUtc: 6 })).toBeNull();
  });

  it("returns null when start === end (quiet disabled)", () => {
    const now = Date.UTC(2026, 5, 8, 6, 0, 0);
    expect(quietHoldEndMs(now, { startHourUtc: 5, endHourUtc: 5 })).toBeNull();
  });
});
