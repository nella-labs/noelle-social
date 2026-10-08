import { describe, expect, it } from "vitest";
import { measuredCountMean, measuredSourceRatio, readSourceCount, readSourceEpochTimestamp, readSourceNonnegativeNumber, readSourceTimestamp, readSourceVoteScore } from "./sourceValues.js";

describe("source measurements", () => {
  it("preserves fractional measured values separately from counts", () => {
    expect(readSourceNonnegativeNumber(null, "", false, -1, Infinity)).toBeNull();
    expect(readSourceNonnegativeNumber("1.5")).toBe(1.5);
    expect(readSourceNonnegativeNumber("0")).toBe(0);
    expect(readSourceNonnegativeNumber(Number.MAX_SAFE_INTEGER + 1)).toBeNull();
  });
  it("averages only measured safe counts without rounding or sum overflow", () => {
    expect(measuredCountMean([null, -1, "", 1.5])).toBeNull();
    expect(measuredCountMean([null, 0, 1, 0])).toBeCloseTo(1 / 3, 12);
    expect(measuredCountMean([Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER])).toBe(Number.MAX_SAFE_INTEGER);
  });
  it("ratios retain measured zero and require a measured positive denominator", () => {
    expect(measuredSourceRatio(0, 2)).toBe(0);
    expect(measuredSourceRatio("3", "2")).toBe(1.5);
    expect(measuredSourceRatio(null, 2)).toBeNull();
    expect(measuredSourceRatio(2, 0)).toBeNull();
    expect(measuredSourceRatio(2, -1)).toBeNull();
    expect(measuredSourceRatio(2, "")).toBeNull();
  });
  it("preserves measured count zero and skips blank, malformed and negative candidates", () => {
    expect(readSourceCount(null, "", "  ", NaN, Infinity, -1)).toBeNull();
    expect(readSourceCount(" ", -1, "0", 9)).toBe(0);
    expect(readSourceCount("12.9")).toBeNull();
  });

  it.each([1.5, "1.5", Number.MAX_SAFE_INTEGER + 1])("does not fabricate a count from %j", value => {
    expect(readSourceCount(value)).toBeNull();
  });

  it("does not let a fractional source candidate shadow measured fallback zero", () => {
    expect(readSourceCount(1.5, 0)).toBe(0);
  });

  it("preserves signed integral Reddit vote scores including real zero", () => {
    expect(readSourceVoteScore(-2)).toBe(-2);
    expect(readSourceVoteScore("-14")).toBe(-14);
    expect(readSourceVoteScore("0")).toBe(0);
    expect(readSourceVoteScore(null, "", "  ", Infinity, NaN, 1.5, Number.MAX_SAFE_INTEGER + 1)).toBeNull();
    expect(readSourceVoteScore("unknown", "-2")).toBe(-2);
  });
});

describe("source timestamps", () => {
  it("retains valid ISO, PostgreSQL-like and Twitter source dates", () => {
    expect(readSourceTimestamp("2024-02-29T12:34:56Z")).toBe("2024-02-29T12:34:56.000Z");
    expect(readSourceTimestamp("2026-10-05 12:34:56+00")).toBe("2026-10-05T12:34:56.000Z");
    expect(readSourceTimestamp("Mon Oct 05 12:34:56 +0000 2026")).toBe("2026-10-05T12:34:56.000Z");
  });

  it.each(["2026-02-30T00:00:00Z", "2026-02-29T00:00:00Z", "2026-04-31T00:00:00Z", "2026-13-01T00:00:00Z", "unknown"])(
    "rejects invalid source calendar %s before Date normalizes it", value => {
      expect(readSourceTimestamp(value)).toBeNull();
    },
  );

  it("keeps the existing string timestamp contract separate from numeric epochs", () => {
    expect(readSourceTimestamp(1_759_665_600)).toBeNull();
    expect(readSourceTimestamp("invalid", "2026-10-05T00:00:00Z")).toBe("2026-10-05T00:00:00.000Z");
  });

  it.each(["0001-01-01T00:00:00+01:00", "9999-12-31T23:00:00-02:00"])(
    "rejects UTC calendar overflow after offset normalization for %s", value => {
      expect(readSourceTimestamp(value)).toBeNull();
    },
  );

  it("requires explicit epoch units and retains measured epoch zero", () => {
    expect(readSourceEpochTimestamp(0, "seconds")).toBe("1970-01-01T00:00:00.000Z");
    expect(readSourceEpochTimestamp(1_759_665_600, "seconds")).toBe("2025-10-05T12:00:00.000Z");
    expect(readSourceEpochTimestamp(1_759_665_600_000, "milliseconds")).toBe("2025-10-05T12:00:00.000Z");
  });

  it.each([null, undefined, "1759665600", NaN, Infinity, -Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1,
    -62_135_596_801_000, 253_402_300_800_000])("rejects malformed or out-of-calendar-range epoch %j", value => {
    expect(readSourceEpochTimestamp(value, "milliseconds")).toBeNull();
  });
});
