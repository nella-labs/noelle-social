import { describe, expect, it } from "vitest";
import { XReplyMaxAgeHoursSchema, resolveXReplyMaxAgeHours } from "./x-reply-policy.js";

describe("shared X reply expiry configuration", () => {
  it.each([undefined, "", " ", "\t"])("defaults omitted or blank configuration %j", raw => {
    expect(XReplyMaxAgeHoursSchema.parse(raw)).toBe(25);
    expect(resolveXReplyMaxAgeHours(raw)).toBe(25);
  });
  it.each([["0", 0], ["48", 48], [" 48 ", 48]] as const)("preserves explicit hours %j", (raw, hours) => {
    expect(XReplyMaxAgeHoursSchema.parse(raw)).toBe(hours);
    expect(resolveXReplyMaxAgeHours(raw)).toBe(hours);
  });
  it.each(["garbage", "-1", "1.5", "Infinity"])("keeps strict worker validation and API fallback for %j", raw => {
    expect(XReplyMaxAgeHoursSchema.safeParse(raw).success).toBe(false);
    expect(resolveXReplyMaxAgeHours(raw)).toBe(25);
  });
});
