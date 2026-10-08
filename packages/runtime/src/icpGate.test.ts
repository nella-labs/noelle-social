import { describe, it, expect } from "vitest";
import { qualifyByHeadline } from "./icpGate.js";

const gate = {
  headlineKeywords: ["founder", "ceo", "building", "yc"],
  headlineExcludeKeywords: ["recruiter", "hiring", "agency"],
};

describe("qualifyByHeadline", () => {
  it("qualifies on an include-keyword substring (case-insensitive)", () => {
    expect(qualifyByHeadline("Founder & CEO at Acme", gate)).toEqual({
      qualified: true,
      reason: "matched:founder",
    });
    expect(qualifyByHeadline("building something new", gate).qualified).toBe(true);
    expect(qualifyByHeadline("YC W24 · solo founder", gate).qualified).toBe(true);
  });

  it("rejects when no include keyword is present", () => {
    expect(qualifyByHeadline("Senior Software Engineer", gate)).toEqual({
      qualified: false,
      reason: "no-keyword-match",
    });
  });

  it("rejects on an exclude keyword even when an include keyword also matches", () => {
    const r = qualifyByHeadline("Technical Recruiter — hiring founders", gate);
    expect(r.qualified).toBe(false);
    expect(r.reason).toBe("excluded:recruiter");
  });

  it("never qualifies a missing or blank headline", () => {
    expect(qualifyByHeadline(null, gate).reason).toBe("no-headline");
    expect(qualifyByHeadline(undefined, gate).reason).toBe("no-headline");
    expect(qualifyByHeadline("   ", gate).reason).toBe("no-headline");
  });

  it("works with no exclude list", () => {
    expect(qualifyByHeadline("Founder", { headlineKeywords: ["founder"] }).qualified).toBe(true);
  });
});
