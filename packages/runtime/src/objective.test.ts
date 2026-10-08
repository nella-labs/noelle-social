import { describe, it, expect } from "vitest";
import { resolveObjective, hasCustomObjective } from "./objective.js";

describe("resolveObjective", () => {
  const fallback = "Drafts on-brand X replies to monitored leads.";

  it("returns the operator objective when set", () => {
    expect(resolveObjective("Find founders venting about X", fallback)).toBe(
      "Find founders venting about X",
    );
  });

  it("trims the operator objective", () => {
    expect(resolveObjective("  hunt for indie devs  ", fallback)).toBe(
      "hunt for indie devs",
    );
  });

  it("falls back to the manifest default when null", () => {
    expect(resolveObjective(null, fallback)).toBe(fallback);
  });

  it("falls back when undefined", () => {
    expect(resolveObjective(undefined, fallback)).toBe(fallback);
  });

  it("falls back when empty or whitespace-only", () => {
    expect(resolveObjective("", fallback)).toBe(fallback);
    expect(resolveObjective("   ", fallback)).toBe(fallback);
    expect(resolveObjective("\n\t", fallback)).toBe(fallback);
  });

  it("trims the fallback too", () => {
    expect(resolveObjective(null, "  padded fallback  ")).toBe("padded fallback");
  });
});

describe("hasCustomObjective", () => {
  it("is true only for a non-empty operator objective", () => {
    expect(hasCustomObjective("x")).toBe(true);
    expect(hasCustomObjective(null)).toBe(false);
    expect(hasCustomObjective(undefined)).toBe(false);
    expect(hasCustomObjective("   ")).toBe(false);
  });
});
