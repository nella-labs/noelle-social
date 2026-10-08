import { describe, expect, it } from "vitest";
import { applyFollowerPolicy } from "./follower-policy.js";

const strong = { onBrand: true, tier: "T1" as const, score: 0.8, isSlop: false };

describe("applyFollowerPolicy", () => {
  it("drops authors under 100 followers even when on-brand", () => {
    const r = applyFollowerPolicy({ followers: 42, ...strong });
    expect(r.onBrand).toBe(false);
    expect(r.bucket).toBe("drop");
    expect(r.reason).toMatch(/100/);
  });

  it("100-499: keeps a strong T1 signal but demotes the tier", () => {
    const r = applyFollowerPolicy({ followers: 250, ...strong });
    expect(r.onBrand).toBe(true);
    expect(r.bucket).toBe("strict");
    expect(r.tier).toBe("T2"); // demoted one step
    expect(r.score).toBeLessThan(0.8); // penalised
  });

  it("100-499: drops a weak (non-T1) signal", () => {
    const r = applyFollowerPolicy({ followers: 250, onBrand: true, tier: "T2", score: 0.5, isSlop: false });
    expect(r.onBrand).toBe(false);
    expect(r.bucket).toBe("strict");
  });

  it("100-499: drops anything already flagged slop", () => {
    const r = applyFollowerPolicy({ followers: 250, onBrand: true, tier: "T1", score: 0.8, isSlop: true });
    expect(r.onBrand).toBe(false);
  });

  it("500-999: mild penalty, tier untouched", () => {
    const r = applyFollowerPolicy({ followers: 750, ...strong });
    expect(r.onBrand).toBe(true);
    expect(r.bucket).toBe("mild");
    expect(r.tier).toBe("T1"); // not demoted
    expect(r.score).toBeLessThan(0.8);
    expect(r.score).toBeGreaterThan(0.6); // but only mildly
  });

  it("1000+: full credit, no change", () => {
    const r = applyFollowerPolicy({ followers: 5000, ...strong });
    expect(r.onBrand).toBe(true);
    expect(r.bucket).toBe("full");
    expect(r.tier).toBe("T1");
    expect(r.score).toBe(0.8);
  });

  it("unknown follower count is neutral — never drops on missing data", () => {
    for (const followers of [null, undefined]) {
      const r = applyFollowerPolicy({ followers, ...strong });
      expect(r.onBrand).toBe(true);
      expect(r.bucket).toBe("unknown");
      expect(r.tier).toBe("T1");
      expect(r.score).toBe(0.8);
    }
  });

  it("does not resurrect an already off-brand lead", () => {
    const r = applyFollowerPolicy({ followers: 5000, onBrand: false, tier: null, score: 0.1, isSlop: false });
    expect(r.onBrand).toBe(false);
  });

  it("tolerates a null score", () => {
    const r = applyFollowerPolicy({ followers: 750, onBrand: true, tier: "T2", score: null, isSlop: false });
    expect(r.onBrand).toBe(true);
    expect(r.score).toBeNull();
  });
});
