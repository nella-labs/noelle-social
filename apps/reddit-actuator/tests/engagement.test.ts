import { describe, it, expect } from "vitest";
import { makeRng } from "../src/lib/rng.js";
import { ENGAGEMENTS, pickEngagement, engagementLabel, type EngagementKind } from "../src/lib/engagement.js";

// Draw many engagements off a deterministic RNG and tally the distribution.
function tally(overrides?: Partial<Record<EngagementKind, number>>, n = 20_000) {
  const rng = makeRng(12345);
  const counts = new Map<EngagementKind, number>();
  for (let i = 0; i < n; i++) {
    const k = pickEngagement(rng, overrides);
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  return counts;
}

describe("pickEngagement — default mix is DEFAULT-OFF (always upvote)", () => {
  it("delivers ONLY 'upvote' with the default weights (save disabled)", () => {
    // The DEFAULT-OFF landmine: with no engagementWeights, behavior is
    // byte-identical to the pre-save actuator — a plain upvote every time.
    const counts = tally(undefined, 5_000);
    expect(counts.get("upvote") ?? 0).toBe(5_000);
    expect(counts.get("save") ?? 0).toBe(0);
  });

  it("the default weight table encodes upvote=100 / save=0", () => {
    const by = new Map(ENGAGEMENTS.map((e) => [e.kind, e.weight]));
    expect(by.get("upvote")).toBe(100);
    expect(by.get("save")).toBe(0);
  });

  it("NEVER exposes a 'downvote' kind (SAVE-ONLY)", () => {
    const kinds = ENGAGEMENTS.map((e) => e.kind);
    expect(kinds).toEqual(["upvote", "save"]);
    expect(kinds).not.toContain("downvote");
  });
});

describe("pickEngagement — overrides (operator opt-in)", () => {
  it("an operator can opt save in without touching code", () => {
    const counts = tally({ upvote: 80, save: 20 }, 20_000);
    const save = (counts.get("save") ?? 0) / 20_000;
    expect(save).toBeGreaterThan(0.12);
    expect(save).toBeLessThan(0.28); // ~0.20
  });

  it("a zero weight disables that kind entirely", () => {
    const counts = tally({ upvote: 0, save: 100 }, 5_000);
    expect(counts.get("upvote") ?? 0).toBe(0);
    expect(counts.get("save") ?? 0).toBe(5_000);
  });

  it("all-zero weights fall back to 'upvote' (always deliverable with one click)", () => {
    const rng = makeRng(1);
    expect(pickEngagement(rng, { upvote: 0, save: 0 })).toBe("upvote");
  });

  it("an empty override object leaves the DEFAULT-OFF upvote-only behavior intact", () => {
    const counts = tally({}, 5_000);
    expect(counts.get("upvote") ?? 0).toBe(5_000);
    expect(counts.get("save") ?? 0).toBe(0);
  });

  it("a non-finite override falls back to that kind's default weight", () => {
    // NaN override for upvote ⇒ default weight (100) used, so upvote still dominates.
    const counts = tally({ upvote: Number.NaN }, 5_000);
    expect(counts.get("upvote") ?? 0).toBe(5_000);
  });

  it("save only ever fires when explicitly opted in", () => {
    const counts = tally({ upvote: 1, save: 50 }, 5_000);
    expect(counts.get("save") ?? 0).toBeGreaterThan(counts.get("upvote") ?? 0);
  });
});

describe("engagementLabel", () => {
  it("maps each kind to its visible word", () => {
    expect(engagementLabel("upvote")).toBe("Upvote");
    expect(engagementLabel("save")).toBe("Save");
  });
});
