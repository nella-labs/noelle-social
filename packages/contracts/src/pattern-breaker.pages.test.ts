import { describe, expect, it } from "vitest";
import {
  decodePatternCursor,
  PatternRulesPageInputSchema,
  PatternAlertsPageInputSchema,
} from "./pattern-breaker.js";

const id = "00000000-0000-4000-8000-000000000001";
describe("pattern page admission", () => {
  it("supplies explicit bounded defaults", () => {
    expect(PatternRulesPageInputSchema.parse({})).toEqual({ section: "all", limit: 50 });
    expect(PatternAlertsPageInputSchema.parse({})).toEqual({ view: "visible", limit: 50 });
  });
  it.each([0, -1, 1.5, 101, Infinity, NaN])("rejects invalid page size %s", (limit) => {
    expect(PatternRulesPageInputSchema.safeParse({ limit }).success).toBe(false);
    expect(PatternAlertsPageInputSchema.safeParse({ limit }).success).toBe(false);
  });
  it("preserves exact microsecond timestamps through cursor transport", () => {
    const cursor = {
      section: "active",
      active: true,
      severity: "high",
      createdAt: "2026-10-01T00:00:00.123456Z",
      id,
    };
    expect(
      PatternRulesPageInputSchema.parse({
        section: "active",
        cursor: decodePatternCursor(JSON.stringify(cursor)),
      })
        .cursor,
    ).toEqual(cursor);
  });
  it.each(["", "x".repeat(513), "not-json", []])(
    "rejects malformed or oversized cursor transport",
    (value) => {
      expect(() => decodePatternCursor(value)).toThrow();
    },
  );
  it("rejects crossed cursor sections and alert views", () => {
    expect(
      PatternRulesPageInputSchema.safeParse({
        section: "active",
        cursor: {
          section: "disabled",
          active: false,
          severity: "high",
          createdAt: "2026-10-01T00:00:00Z",
          id,
        },
      }).success,
    ).toBe(false);
    expect(
      PatternAlertsPageInputSchema.safeParse({
        view: "visible",
        cursor: {
          view: "history",
          createdAt: "2026-10-01T00:00:00Z",
          id,
        },
      }).success,
    ).toBe(false);
  });
  it("rejects extra fields, calendar errors and wrong cursor shapes", () => {
    const cursor = { view: "history", createdAt: "2026-02-30T00:00:00Z", id };
    expect(PatternAlertsPageInputSchema.safeParse({ cursor }).success).toBe(false);
    expect(PatternRulesPageInputSchema.safeParse({ cursor }).success).toBe(false);
    expect(PatternAlertsPageInputSchema.safeParse({ arbitrary: true }).success).toBe(false);
  });
});
