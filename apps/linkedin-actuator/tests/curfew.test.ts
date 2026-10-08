import { describe, it, expect } from "vitest";
import { isWriteCurfew, WRITE_CURFEW_ENABLED } from "../src/lib/curfew.js";

// Canary: the write-curfew is DISABLED by default (manual runs write at any hour).
// If someone flips the GLOBAL default, this test fails on purpose — update it
// intentionally. The per-run `enabled` flag (Full automatic / auto-start) is
// exercised separately below.
describe("write curfew — global default (manual runs)", () => {
  it("is DISABLED by default — writes allowed at every hour of the day", () => {
    expect(WRITE_CURFEW_ENABLED).toBe(false);
    for (let h = 0; h < 24; h++) {
      const at = new Date(2026, 0, 15, h, 30, 0).getTime();
      expect(isWriteCurfew(at)).toBe(false); // single-arg = global default (off)
      expect(isWriteCurfew(at, false)).toBe(false); // explicitly off
    }
  });
});

describe("write curfew — enabled (Full automatic / auto-start)", () => {
  it("holds posts 1am–9am local and allows them the rest of the day", () => {
    for (let h = 0; h < 24; h++) {
      const at = new Date(2026, 0, 15, h, 30, 0).getTime();
      const held = h >= 1 && h < 9; // the non-wrapping 1→9 window
      expect(isWriteCurfew(at, true)).toBe(held);
    }
  });

  it("is inclusive at 1am and exclusive at 9am", () => {
    const at = (h: number, m = 0) => new Date(2026, 0, 15, h, m, 0).getTime();
    expect(isWriteCurfew(at(0, 59), true)).toBe(false); // before the window
    expect(isWriteCurfew(at(1, 0), true)).toBe(true); // inclusive lower bound
    expect(isWriteCurfew(at(8, 59), true)).toBe(true); // last held minute
    expect(isWriteCurfew(at(9, 0), true)).toBe(false); // exclusive upper bound
  });
});
