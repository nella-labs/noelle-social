import { describe, expect, it } from "vitest";
import {
  applyRecency,
  leadAge,
  MAX_LEAD_AGE_DAYS,
  recencyMultiplier,
  RECENCY_DECAY,
} from "./recency.js";

const NOW = new Date("2026-06-08T12:00:00Z");
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000).toISOString();

describe("leadAge", () => {
  it("flags a post older than the cutoff as expired", () => {
    const a = leadAge(daysAgo(MAX_LEAD_AGE_DAYS + 1), NOW);
    expect(a.expired).toBe(true);
    expect(a.ageDays).toBeCloseTo(16, 5);
  });

  it("keeps a post inside the window", () => {
    const a = leadAge(daysAgo(MAX_LEAD_AGE_DAYS - 1), NOW);
    expect(a.expired).toBe(false);
  });

  it("treats exactly the cutoff as not-yet-expired (strictly older drops)", () => {
    expect(leadAge(daysAgo(MAX_LEAD_AGE_DAYS), NOW).expired).toBe(false);
  });

  it("fails open on a missing or unparseable posted_at", () => {
    for (const bad of [undefined, null, "", "not-a-date", 12345, "2026-02-30T10:00:00Z", "Mon Feb 30 10:00:00 +0000 2026"]) {
      const a = leadAge(bad, NOW);
      expect(a.expired).toBe(false);
      expect(a.ageDays).toBeNull();
      expect(a.postedAtIso).toBeNull();
    }
  });
});

describe("recencyMultiplier", () => {
  it("is 1.0 for a brand-new post", () => {
    expect(recencyMultiplier(daysAgo(0), NOW)).toBeCloseTo(1, 5);
  });

  it("bottoms out at (1 - RECENCY_DECAY) at the window edge", () => {
    expect(recencyMultiplier(daysAgo(MAX_LEAD_AGE_DAYS), NOW)).toBeCloseTo(1 - RECENCY_DECAY, 5);
  });

  it("monotonically decreases as the post ages", () => {
    const fresh = recencyMultiplier(daysAgo(1), NOW);
    const mid = recencyMultiplier(daysAgo(7), NOW);
    const old = recencyMultiplier(daysAgo(14), NOW);
    expect(fresh).toBeGreaterThan(mid);
    expect(mid).toBeGreaterThan(old);
  });

  it("never penalises a future-dated post (clock skew) or an undateable one", () => {
    expect(recencyMultiplier(new Date(NOW.getTime() + 86_400_000).toISOString(), NOW)).toBe(1);
    expect(recencyMultiplier(undefined, NOW)).toBe(1);
  });
});

describe("applyRecency", () => {
  it("passes null through untouched", () => {
    expect(applyRecency(null, daysAgo(1), NOW)).toBeNull();
  });

  it("scales a fresh score by ~1 and an old score down", () => {
    expect(applyRecency(0.8, daysAgo(0), NOW)).toBeCloseTo(0.8, 5);
    expect(applyRecency(0.8, daysAgo(MAX_LEAD_AGE_DAYS), NOW)).toBeCloseTo(0.8 * (1 - RECENCY_DECAY), 5);
  });

  it("keeps the result within [0, 1]", () => {
    const v = applyRecency(1, daysAgo(0), NOW)!;
    expect(v).toBeLessThanOrEqual(1);
    expect(v).toBeGreaterThanOrEqual(0);
  });
});
