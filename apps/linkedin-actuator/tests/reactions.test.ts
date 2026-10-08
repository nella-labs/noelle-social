import { describe, it, expect } from "vitest";
import { makeRng } from "../src/lib/rng.js";
import { REACTIONS, pickReaction, reactionLabel, type ReactionType } from "../src/lib/reactions.js";

// Draw many reactions off a deterministic RNG and tally the distribution.
function tally(overrides?: Partial<Record<ReactionType, number>>, n = 20_000) {
  const rng = makeRng(12345);
  const counts = new Map<ReactionType, number>();
  for (let i = 0; i < n; i++) {
    const r = pickReaction(rng, overrides);
    counts.set(r, (counts.get(r) ?? 0) + 1);
  }
  return counts;
}

describe("pickReaction — default mix", () => {
  const n = 20_000;
  const counts = tally(undefined, n);

  it("is dominated by LIKE (the actor still mostly likes)", () => {
    const like = (counts.get("LIKE") ?? 0) / n;
    expect(like).toBeGreaterThan(0.6);
    expect(like).toBeLessThan(0.8); // ~0.70
  });

  it("leans toward Support (EMPATHY) and applause (PRAISE) over the rest", () => {
    const support = counts.get("EMPATHY") ?? 0;
    const applause = counts.get("PRAISE") ?? 0;
    const love = counts.get("APPRECIATION") ?? 0;
    const funny = counts.get("ENTERTAINMENT") ?? 0;
    // The two "inclined" secondary reactions each outweigh Love and Funny.
    expect(support).toBeGreaterThan(love);
    expect(support).toBeGreaterThan(funny);
    expect(applause).toBeGreaterThan(love);
    expect(applause).toBeGreaterThan(funny);
  });

  it("eventually produces every reaction type (nothing is dead)", () => {
    for (const r of REACTIONS) expect(counts.get(r.type) ?? 0).toBeGreaterThan(0);
  });
});

describe("pickReaction — overrides", () => {
  it("a zero weight disables that reaction entirely", () => {
    const counts = tally({ LIKE: 0 }, 5_000);
    expect(counts.get("LIKE") ?? 0).toBe(0);
  });

  it("all-zero weights fall back to LIKE (always deliverable with one click)", () => {
    const rng = makeRng(1);
    const overrides = { LIKE: 0, PRAISE: 0, EMPATHY: 0, APPRECIATION: 0, INTEREST: 0, ENTERTAINMENT: 0 };
    expect(pickReaction(rng, overrides)).toBe("LIKE");
  });

  it("a non-finite override falls back to that reaction's default weight", () => {
    // NaN override for LIKE ⇒ default weight used, so LIKE still dominates.
    const counts = tally({ LIKE: Number.NaN }, 5_000);
    expect((counts.get("LIKE") ?? 0) / 5_000).toBeGreaterThan(0.6);
  });

  it("can be retuned to make a secondary reaction dominant", () => {
    const counts = tally({ LIKE: 1, EMPATHY: 100 }, 5_000);
    expect(counts.get("EMPATHY") ?? 0).toBeGreaterThan(counts.get("LIKE") ?? 0);
  });
});

describe("reactionLabel", () => {
  it("maps the Voyager enum to LinkedIn's visible word", () => {
    expect(reactionLabel("PRAISE")).toBe("Celebrate");
    expect(reactionLabel("EMPATHY")).toBe("Support");
    expect(reactionLabel("LIKE")).toBe("Like");
  });
});
