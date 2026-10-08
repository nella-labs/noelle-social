import { describe, expect, it } from "vitest";
import {
  hasOwnPerformanceRecommendations,
  renderOwnPerformanceBlock,
  summarizeOwnPerformance,
  type OwnPerfInputRow,
} from "./own-performance.js";

const row = (over: Partial<OwnPerfInputRow> = {}): OwnPerfInputRow => ({
  externalId: "1", hook: "a measured post", pillar: "craft", angle: "observation",
  likes: 10, reposts: 2, replies: 3, ...over,
});

describe("observed own-post outcomes", () => {
  it("keeps replies, amplification and bookmarks separate without weighting them", () => {
    const post = summarizeOwnPerformance(
      [row({ views: 1000, quotes: 4, bookmarks: 5 })], { topPosts: 5 },
    ).topPosts[0]!;
    expect(post.engagement).toBe(19);
    expect(post.response).toBe(3);
    expect(post.amplification).toBe(6);
    expect(post.bookmarks).toBe(5);
    expect(post.rates).toEqual({ engagement: 19, response: 3, amplification: 6, bookmarks: 5 });
  });

  it("distinguishes omitted outcomes from measured zero", () => {
    const posts = summarizeOwnPerformance([
      row({ externalId: "unknown", views: 1000 }),
      row({ externalId: "zero", views: 1000, quotes: 0, bookmarks: 0 }),
    ], { topPosts: 5 }).topPosts;
    expect(posts.find((p) => p.externalId === "unknown")).toMatchObject({
      quotes: null, bookmarks: null, rates: { amplification: null, bookmarks: null },
    });
    expect(posts.find((p) => p.externalId === "zero")).toMatchObject({
      quotes: 0, bookmarks: 0, rates: { amplification: 2, bookmarks: 0 },
    });
  });

  it("sanitizes invalid mandatory counts without treating optional invalid counts as observed", () => {
    const perf = summarizeOwnPerformance([
      row({ likes: Number.NaN, reposts: -20, replies: Infinity, quotes: -1, bookmarks: Infinity, views: NaN }),
    ], { topPosts: 5 });
    expect(perf.topPosts).toEqual([]);
    expect(perf.pillarRanking[0]).toMatchObject({
      avgEngagement: 0, quotesMeasuredPosts: 0, bookmarksMeasuredPosts: 0, ratedPosts: 0,
    });
  });

  it("uses rates only when impressions are positive and ranks their cohort independently", () => {
    const posts = summarizeOwnPerformance([
      row({ externalId: "raw", likes: 500, reposts: 0, replies: 0, views: null }),
      row({ externalId: "reach", likes: 100, reposts: 0, replies: 0, views: 10000 }),
      row({ externalId: "efficient", likes: 20, reposts: 0, replies: 0, views: 100 }),
      row({ externalId: "zeroViews", likes: 1, reposts: 0, replies: 0, views: 0 }),
    ], { topPosts: 5 }).topPosts;
    expect(posts.filter((p) => p.comparisonBasis === "per_1000_views").map((p) => p.externalId))
      .toEqual(["efficient", "reach"]);
    expect(posts.filter((p) => p.comparisonBasis === "counts").map((p) => p.externalId))
      .toEqual(["raw", "zeroViews"]);
    expect(posts.find((p) => p.externalId === "zeroViews")?.rates.engagement).toBeNull();
  });
});

describe("conservative own-post learning", () => {
  it("requires three unique comparable posts before recommending a pillar", () => {
    const two = summarizeOwnPerformance([
      row({ externalId: "a" }), row({ externalId: "b" }), row({ externalId: "a" }),
    ], { topPosts: 5 });
    expect(two.pillarRanking[0]?.posts).toBe(2);
    expect(hasOwnPerformanceRecommendations(two)).toBe(false);
    const three = summarizeOwnPerformance([
      row({ externalId: "a" }), row({ externalId: "b" }), row({ externalId: "c" }),
    ], { topPosts: 5 });
    expect(three.pillarRanking[0]).toMatchObject({ recommendationBasis: "counts", recommendationSupported: true });
    expect(hasOwnPerformanceRecommendations(three)).toBe(true);
  });

  it("does not pool a two-post rate sample with a one-post count sample for support", () => {
    const perf = summarizeOwnPerformance([
      row({ externalId: "a", views: 1000 }), row({ externalId: "b", views: 1000 }), row({ externalId: "c" }),
    ], { topPosts: 5 });
    expect(perf.pillarRanking[0]).toMatchObject({
      posts: 3, ratedPosts: 2, countOnlyPosts: 1, recommendationSupported: false, recommendationBasis: null,
    });
    expect(hasOwnPerformanceRecommendations(perf)).toBe(false);
  });

  it("rolls rates up from paired exposures and reports outcome-specific coverage", () => {
    const perf = summarizeOwnPerformance([
      row({ externalId: "a", likes: 100, reposts: 2, replies: 5, views: 1000, quotes: 3, bookmarks: 8 }),
      row({ externalId: "b", likes: 20, reposts: 0, replies: 1, views: 100, quotes: null, bookmarks: null }),
      row({ externalId: "c", likes: 1, reposts: 0, replies: 0, views: 100, quotes: 0, bookmarks: 0 }),
    ], { topPosts: 5 });
    const bucket = perf.pillarRanking[0]!;
    expect(bucket).toMatchObject({
      posts: 3, ratedPosts: 3, quotesMeasuredPosts: 2, bookmarksMeasuredPosts: 2,
      amplificationRatedPosts: 2, bookmarksRatedPosts: 2,
      recommendationSupported: true, recommendationBasis: "per_1000_views",
    });
    expect(bucket.rates.response).toBe(5);
    expect(bucket.rates.amplification).toBeCloseTo(50 / 11);
    expect(bucket.rates.bookmarks).toBeCloseTo(80 / 11);
  });

  it("keeps measured zero outcomes in support while rejecting unsupported winner claims", () => {
    const perf = summarizeOwnPerformance(
      ["a", "b", "c"].map((externalId) => row({ externalId, likes: 0, reposts: 0, replies: 0 })),
      { topPosts: 5 },
    );
    expect(perf.pillarRanking[0]).toMatchObject({ posts: 3, avgEngagement: 0, recommendationSupported: false });
    expect(hasOwnPerformanceRecommendations(perf)).toBe(false);
  });

  it("does not present count-only outcome coverage as rate coverage", () => {
    const bucket = summarizeOwnPerformance([
      row({ externalId: "rate", views: 1000 }),
      row({ externalId: "counts", quotes: 0, bookmarks: 0 }),
    ], { topPosts: 5 }).pillarRanking[0]!;
    expect(bucket).toMatchObject({
      quotesMeasuredPosts: 1, bookmarksMeasuredPosts: 1,
      amplificationRatedPosts: 0, bookmarksRatedPosts: 0,
      rates: { amplification: null, bookmarks: null },
    });
  });

  it("renders rates and counts as separate observations with sample limits and exploration", () => {
    const perf = summarizeOwnPerformance([
      row({ externalId: "a", views: 1000, quotes: 1, bookmarks: 2 }), row({ externalId: "b" }),
    ], { topPosts: 5 });
    const block = renderOwnPerformanceBlock(perf);
    expect(block).toContain("per 1,000 views");
    expect(block).toContain("Count-only");
    expect(block).toContain("Insufficient comparable posts");
    expect(block).toContain("exploration");
    expect(block).toContain("unavailable");
    expect(block).not.toContain("best-performing pillars");
  });
});
