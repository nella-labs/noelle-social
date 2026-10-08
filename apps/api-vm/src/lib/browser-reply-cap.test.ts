import { describe, expect, it } from "vitest";
import { resolveDailyWriteCap } from "./browser-reply-cap.js";

describe("browser daily cap inputs", () => {
  it.each([undefined, null, "", "   ", "\n"])("uses the default for an unset or blank value: %s", value => {
    expect(resolveDailyWriteCap(value, 40)).toBe(40);
  });
  it("preserves an explicit zero and explicit unlimited setting", () => {
    expect(resolveDailyWriteCap("0", 40)).toBe(0);
    expect(resolveDailyWriteCap(" unlimited ", 40)).toBe(Infinity);
  });
});
