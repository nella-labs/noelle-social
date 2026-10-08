import { describe, expect, it } from "vitest";
import { readXSourceCount, readXSourceId } from "./tweet-source-values.js";

describe("source identity and measurement boundaries", () => {
  it("keeps measured zero counts while rejecting an unset zero platform identity", () => {
    expect(readXSourceCount(0)).toBe(0);
    expect(readXSourceId("0", 0, "000")).toBeNull();
  });
  it("preserves an exact large ID and falls through unsafe numeric identities", () => {
    expect(readXSourceId(1987654321000000000, "1987654321000000001")).toBe("1987654321000000001");
  });
});
