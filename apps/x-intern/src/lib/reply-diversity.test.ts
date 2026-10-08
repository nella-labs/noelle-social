import { describe, it, expect } from "vitest";
import { jaccard, maxSimilarity, gateReply } from "./reply-diversity.js";

describe("reply-diversity", () => {
  it("jaccard is 1 for identical sets, 0 for disjoint, 1 for two empty", () => {
    expect(jaccard(new Set(["abc"]), new Set(["abc"]))).toBe(1);
    expect(jaccard(new Set(["abc"]), new Set(["xyz"]))).toBe(0);
    expect(jaccard(new Set(), new Set())).toBe(1);
  });

  it("maxSimilarity returns the closest prior", () => {
    const priors = ["completely unrelated sentence over here", "great point, totally agree with this"];
    expect(maxSimilarity("great point, totally agree with this", priors)).toBeCloseTo(1, 5);
    expect(maxSimilarity("zzz qqq wxy vut", priors)).toBeLessThan(0.2);
  });

  it.each([["ok", "hi"], ["a", "b"], ["🙂", "🙌"]])("keeps distinct short replies %s and %s", (text, prior) => {
    expect(maxSimilarity(text, [prior])).toBe(0);
    expect(gateReply(text, { priors: [prior] }).ok).toBe(true);
  });

  it.each([[" OK ", "ok"], [" A ", "a"], ["🙂", "🙂"]])("blocks a normalized exact short repeat %s", (text, prior) => {
    expect(maxSimilarity(text, [prior])).toBe(1);
    expect(gateReply(text, { priors: [prior] }).reason).toBe("near-duplicate");
  });

  it("blocks a near-duplicate of a recent send", () => {
    const priors = ["Great point, totally agree with this take."];
    const r = gateReply("Great point, totally agree with this take!!", { priors });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("near-duplicate");
    expect(r.similarity).toBeGreaterThanOrEqual(0.5);
  });

  it("passes a genuinely distinct, clean reply", () => {
    const priors = ["Great point, totally agree with this take."];
    const r = gateReply("we hit the same wall last month, ended up caching the token per request", { priors });
    expect(r.ok).toBe(true);
    expect(r.reason).toBeUndefined();
  });

  it("blocks AI-slop even with no priors", () => {
    const r = gateReply(
      "This isn't just a tool, it's a game-changer that will revolutionize your workflow.",
      { priors: [] },
    );
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("ai-slop");
    expect(r.slopScore).toBeGreaterThanOrEqual(0.5);
  });

  it("respects a custom similarity threshold", () => {
    const priors = ["the retry logic was the actual fix here honestly"];
    const text = "the retry logic was the real fix here honestly";
    expect(gateReply(text, { priors, simThreshold: 0.3 }).ok).toBe(false);
    expect(gateReply(text, { priors, simThreshold: 0.95 }).ok).toBe(true);
  });
});
