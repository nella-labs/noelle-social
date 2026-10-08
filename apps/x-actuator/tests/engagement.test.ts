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

describe("pickEngagement — default mix is default-OFF (always Like)", () => {
  it("never publicly amplifies with the default weights (repost stays off)", () => {
    // bookmark is enabled so the gesture varies, but repost is a PUBLIC content
    // decision and must stay opt-in.
    const seen = new Set<string>();
    const rng = makeRng(5);
    for (let i = 0; i < 2000; i++) seen.add(pickEngagement(rng));
    expect(seen.has("repost")).toBe(false);
    expect(seen.has("like")).toBe(true);
    expect(seen.has("bookmark")).toBe(true);
  });

  it("the default weight table encodes like=88 / bookmark=12 / repost=0", () => {
    const w = Object.fromEntries(ENGAGEMENTS.map((e) => [e.kind, e.weight]));
    expect(w).toEqual({ like: 88, bookmark: 12, repost: 0 });
  });

  it("bookmark REPLACES a like rather than adding a write (one action per pick)", () => {
    // pickEngagement returns exactly one kind, so enabling bookmark does not
    // raise the write count — it only changes which write happens.
    const rng = makeRng(11);
    for (let i = 0; i < 500; i++) {
      const k = pickEngagement(rng);
      expect(["like", "bookmark", "repost"]).toContain(k);
    }
  });
});

describe("pickEngagement — overrides (operator opt-in)", () => {
  it("an operator can opt bookmark in without touching code", () => {
    const counts = tally({ like: 80, bookmark: 20 }, 20_000);
    const bookmark = (counts.get("bookmark") ?? 0) / 20_000;
    expect(bookmark).toBeGreaterThan(0.12);
    expect(bookmark).toBeLessThan(0.28); // ~0.20
    expect(counts.get("repost") ?? 0).toBe(0); // still off unless opted in
  });

  it("a zero weight disables that kind entirely", () => {
    const counts = tally({ like: 0, bookmark: 100 }, 5_000);
    expect(counts.get("like") ?? 0).toBe(0);
    expect(counts.get("bookmark") ?? 0).toBe(5_000);
  });

  it("all-zero weights fall back to 'like' (always deliverable with one click)", () => {
    const rng = makeRng(1);
    expect(pickEngagement(rng, { like: 0, bookmark: 0, repost: 0 })).toBe("like");
  });

  it("a non-finite override falls back to that kind's default weight", () => {
    // NaN override for like ⇒ its default weight (88) is used, so like still
    // dominates the mix rather than dropping out. (It is no longer 100% of the
    // draw, because bookmark now carries a real default weight.)
    const counts = tally({ like: Number.NaN }, 5_000);
    const like = counts.get("like") ?? 0;
    expect(like).toBeGreaterThan(4_000); // ~88%
    expect(like + (counts.get("bookmark") ?? 0)).toBe(5_000);
    expect(counts.get("repost") ?? 0).toBe(0);
  });

  it("repost only ever fires when explicitly opted in", () => {
    const counts = tally({ like: 1, repost: 50 }, 5_000);
    expect(counts.get("repost") ?? 0).toBeGreaterThan(counts.get("like") ?? 0);
  });
});

describe("engagementLabel", () => {
  it("maps each kind to its visible word", () => {
    expect(engagementLabel("like")).toBe("Like");
    expect(engagementLabel("bookmark")).toBe("Bookmark");
    expect(engagementLabel("repost")).toBe("Repost");
  });
});
