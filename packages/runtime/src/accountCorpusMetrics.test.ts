import { expect, it } from "vitest";
import { computePerfRollup, corpusEngagement } from "./accountCorpusMetrics.js";

it("averages only measured values and samples only measured likes", () => {
  expect(computePerfRollup([{ externalId: "unknown", likeCount: null, commentCount: null },
    { externalId: "known", likeCount: 20, commentCount: 4 }])).toEqual({ avgLikeCount: 20,
      avgCommentCount: 4, postsAnalyzed: 2, samplePostIds: ["known"] });
});
it("keeps all-unknown and empty averages unknown", () => {
  expect(computePerfRollup([{ externalId: "unknown", likeCount: null, commentCount: null }])).toEqual({
    avgLikeCount: null, avgCommentCount: null, postsAnalyzed: 1, samplePostIds: [] });
  expect(computePerfRollup([])).toEqual({ avgLikeCount: null, avgCommentCount: null, postsAnalyzed: 0, samplePostIds: [] });
});
it("retains measured zero and fractional means with the existing sample ordering", () => {
  expect(computePerfRollup([{ externalId: "a", likeCount: 0, commentCount: 0 },
    { externalId: "b", likeCount: 3, commentCount: 1 }])).toEqual({ avgLikeCount: 1.5,
      avgCommentCount: 0.5, postsAnalyzed: 2, samplePostIds: ["b", "a"] });
});
it("keeps the account rollup two-decimal rounding after shared mean delegation", () => {
  expect(computePerfRollup([0, 0, 1].map((likeCount, i) => ({ externalId: String(i), likeCount, commentCount: null }))).avgLikeCount).toBe(0.33);
});
it("excludes malformed and unsafe values and caps samples at eight", () => {
  const corpus = Array.from({ length: 10 }, (_, i) => ({ externalId: String(i), likeCount: i, commentCount: 0 }));
  corpus.push({ externalId: "invalid", likeCount: -1, commentCount: Number.MAX_SAFE_INTEGER + 1 });
  expect(computePerfRollup(corpus)).toEqual({ avgLikeCount: 4.5, avgCommentCount: 0,
    postsAnalyzed: 11, samplePostIds: ["9", "8", "7", "6", "5", "4", "3", "2"] });
});
it("requires both measured counts and a safe total engagement", () => {
  expect(corpusEngagement(0, 0)).toBe(0);
  expect(corpusEngagement(5, null)).toBeNull();
  expect(corpusEngagement(Number.MAX_SAFE_INTEGER, 1)).toBeNull();
});
