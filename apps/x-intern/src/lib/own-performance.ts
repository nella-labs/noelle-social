import { renderOwnPerformanceEvidence } from "./own-performance-render.js";
import {
  aggregateOutcomeRates, compareOwnPosts, observeOwnPost,
  type OutcomeComparison, type OutcomeRates, type OwnPerfInputRow, type OwnPerfPost,
} from "./own-performance-outcomes.js";
export type { OwnPerfInputRow, OwnPerfPost } from "./own-performance-outcomes.js";

/** One pillar or angle, with comparable sample sizes and optional-outcome coverage. */
export interface OwnPerfBucket {
  key: string;
  /** Legacy observed count average across all posts, including zero outcomes. */
  avgEngagement: number;
  posts: number;
  ratedPosts: number;
  countOnlyPosts: number;
  quotesMeasuredPosts: number;
  bookmarksMeasuredPosts: number;
  amplificationRatedPosts: number;
  bookmarksRatedPosts: number;
  avgCountOnlyEngagement: number | null;
  rates: OutcomeRates;
  recommendationSupported: boolean;
  recommendationBasis: OutcomeComparison | null;
}

export interface OwnPerformance {
  /** Rate and count cohorts are ordered independently, with rate samples first. */
  topPosts: OwnPerfPost[];
  pillarRanking: OwnPerfBucket[];
  angleRanking: OwnPerfBucket[];
}

const MIN_COMPARABLE_POSTS = 3;

function rollup(posts: OwnPerfPost[], pick: (p: OwnPerfPost) => string | null): OwnPerfBucket[] {
  const groups = new Map<string, OwnPerfPost[]>();
  for (const post of posts) {
    const key = (pick(post) ?? "").trim();
    if (!key) continue;
    const group = groups.get(key) ?? [];
    group.push(post);
    groups.set(key, group);
  }
  return [...groups.entries()].map(([key, group]): OwnPerfBucket => {
    const rated = group.filter((p) => p.comparisonBasis === "per_1000_views");
    const counts = group.filter((p) => p.comparisonBasis === "counts");
    const avg = (values: OwnPerfPost[]) => values.reduce((sum, p) => sum + p.engagement, 0) / values.length;
    const rates = aggregateOutcomeRates(rated);
    const recommendationBasis = rated.length >= MIN_COMPARABLE_POSTS && (rates.engagement ?? 0) > 0
      ? "per_1000_views" : counts.length >= MIN_COMPARABLE_POSTS && avg(counts) > 0 ? "counts" : null;
    return {
      key, posts: group.length, avgEngagement: avg(group),
      ratedPosts: rated.length, countOnlyPosts: counts.length,
      quotesMeasuredPosts: group.filter((p) => p.quotes != null).length,
      bookmarksMeasuredPosts: group.filter((p) => p.bookmarks != null).length,
      amplificationRatedPosts: rated.filter((p) => p.quotes != null).length,
      bookmarksRatedPosts: rated.filter((p) => p.bookmarks != null).length,
      avgCountOnlyEngagement: counts.length ? avg(counts) : null,
      rates, recommendationBasis, recommendationSupported: recommendationBasis != null,
    };
  }).sort((a, b) => {
    const ratedA = a.ratedPosts > 0;
    const ratedB = b.ratedPosts > 0;
    if (ratedA !== ratedB) return ratedA ? -1 : 1;
    return (ratedA ? (b.rates.engagement ?? 0) - (a.rates.engagement ?? 0)
      : (b.avgCountOnlyEngagement ?? 0) - (a.avgCountOnlyEngagement ?? 0)) || a.key.localeCompare(b.key);
  });
}

export function summarizeOwnPerformance(rows: OwnPerfInputRow[], opts: { topPosts: number }): OwnPerformance {
  const seen = new Set<string>();
  const posts = rows.filter((r) => {
    if (seen.has(r.externalId)) return false;
    seen.add(r.externalId);
    return true;
  }).map(observeOwnPost);
  const limit = Number.isFinite(opts.topPosts) ? Math.min(100, Math.max(0, Math.floor(opts.topPosts))) : 0;
  return {
    topPosts: posts.filter((p) => (p.engagement > 0 || (p.bookmarks ?? 0) > 0) && p.hook.length > 0)
      .sort(compareOwnPosts).slice(0, limit),
    pillarRanking: rollup(posts, (p) => p.pillar),
    angleRanking: rollup(posts, (p) => p.angle),
  };
}

export function hasOwnPerformanceSignal(perf: OwnPerformance | null | undefined): boolean {
  return !!perf && (perf.topPosts.length > 0 || perf.pillarRanking.length > 0 || perf.angleRanking.length > 0);
}

/** Sparse observations can be displayed but cannot justify steering the batch. */
export function hasOwnPerformanceRecommendations(perf: OwnPerformance | null | undefined): boolean {
  return !!perf && [...perf.pillarRanking, ...perf.angleRanking].some((b) => b.recommendationSupported);
}

/** Keep sparse observations visible without promoting them to recommendations. */
export function renderOwnPerformanceBlock(perf: OwnPerformance | null | undefined): string {
  if (!perf || !hasOwnPerformanceSignal(perf)) return "";
  return renderOwnPerformanceEvidence(perf, hasOwnPerformanceRecommendations(perf));
}
