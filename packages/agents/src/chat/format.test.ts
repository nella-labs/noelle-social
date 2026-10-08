import { describe, expect, it } from "vitest";
import { formatRelativeTime, truncate } from "./format.js";

describe("truncate", () => {
  it("returns the input unchanged when it fits the max", () => {
    expect(truncate("hello", 10)).toBe("hello");
    expect(truncate("hello", 5)).toBe("hello");
  });

  it("ellipsises overflow inside the budget", () => {
    expect(truncate("hello world", 5)).toBe("hell…");
    expect(truncate("hello world", 8)).toBe("hello w…");
  });

  it("trims trailing whitespace before the ellipsis", () => {
    expect(truncate("hello world there", 7)).toBe("hello…");
  });
});

describe("formatRelativeTime", () => {
  const now = new Date("2026-05-26T12:00:00.000Z");

  it("returns 'never' for null / invalid input", () => {
    expect(formatRelativeTime(null, now)).toBe("never");
    expect(formatRelativeTime(undefined, now)).toBe("never");
    expect(formatRelativeTime("not-a-date", now)).toBe("never");
  });

  it("collapses sub-minute deltas (including future) to 'just now'", () => {
    expect(formatRelativeTime("2026-05-26T11:59:30.000Z", now)).toBe("just now");
    expect(formatRelativeTime("2026-05-26T12:05:00.000Z", now)).toBe("just now");
  });

  it("formats minutes, hours, and days", () => {
    expect(formatRelativeTime("2026-05-26T11:55:00.000Z", now)).toBe("5m ago");
    expect(formatRelativeTime("2026-05-26T09:00:00.000Z", now)).toBe("3h ago");
    expect(formatRelativeTime("2026-05-24T12:00:00.000Z", now)).toBe("2d ago");
  });
});
