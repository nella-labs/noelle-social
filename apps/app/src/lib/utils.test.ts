import { describe, it, expect } from "vitest";
import { normalizeLinkedinHandle } from "./utils";

describe("normalizeLinkedinHandle", () => {
  it("strips a trailing -<hex id> auto-suffix so a raw slug and a clean vanity collapse", () => {
    // The exact duplicate the operator hit: a feeder source stored under the raw
    // member slug and a watchlist contact under the clean vanity are one person.
    expect(normalizeLinkedinHandle("kaia-tham-7bb065343")).toBe("kaia-tham");
    expect(normalizeLinkedinHandle("kaia-tham")).toBe("kaia-tham");
    expect(normalizeLinkedinHandle("matthew-martin-9b4952282")).toBe("matthew-martin");
  });

  it("lowercases and trims", () => {
    expect(normalizeLinkedinHandle("  Kaia-Tham-7BB065343 ")).toBe("kaia-tham");
  });

  it("leaves clean multi-word and plain handles untouched", () => {
    expect(normalizeLinkedinHandle("annielongg")).toBe("annielongg");
    expect(normalizeLinkedinHandle("noahkostesku")).toBe("noahkostesku");
    // A real word tail (not a 6+ hex run) must NOT be stripped.
    expect(normalizeLinkedinHandle("john-smith-marketing")).toBe("john-smith-marketing");
  });

  it("only strips a 6+ char hex run, not short numeric tails", () => {
    // 4-digit tail is too short to be a member-id suffix — keep it.
    expect(normalizeLinkedinHandle("agent-007")).toBe("agent-007");
  });
});
