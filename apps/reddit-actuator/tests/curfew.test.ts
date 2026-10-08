import { describe, it, expect } from "vitest";
import { isWriteCurfew, WRITE_CURFEW_ENABLED } from "../src/lib/curfew.js";

// Canary: the write-curfew is deliberately DISABLED (writes allowed at any hour).
// If someone re-enables it, this test fails on purpose — update it intentionally.
describe("write curfew", () => {
  it("is currently DISABLED — writes allowed at every hour of the day", () => {
    expect(WRITE_CURFEW_ENABLED).toBe(false);
    for (let h = 0; h < 24; h++) {
      const at = new Date(2026, 0, 15, h, 30, 0).getTime();
      expect(isWriteCurfew(at)).toBe(false);
    }
  });
});
