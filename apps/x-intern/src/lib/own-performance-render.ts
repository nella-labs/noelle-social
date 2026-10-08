import type { OwnPerformance } from "./own-performance.js";

const metric = (value: number | null) => value == null ? "unavailable" : String(Math.round(value * 10) / 10);

/** Render separated comparison cohorts and evidence limits for the idea generator. */
export function renderOwnPerformanceEvidence(perf: OwnPerformance, recommendations: boolean): string {
  const lines = [
    "## What's already working for YOU (your own posts, measured observations)",
    "Observed outcomes are separate: replies are responses, reposts + quotes are amplification, bookmarks are saves.",
    "These are observations, not X ranking weights or guaranteed distribution. Missing outcomes are unavailable, never zero.",
    "Rate and count-only cohorts are separate; never compare their numeric scores. Rates use paired measurements per 1,000 views.",
    "Post age and audience can still differ. No dwell, profile visits, follows, hides, mutes, blocks or reports were measured here.",
    "Borrow a supported pattern, never rewrite or repeat a specific past take. Keep at least one new idea for exploration outside observed leaders.",
  ];
  if (!recommendations) {
    lines.push("Insufficient comparable posts: require at least 3 distinct posts in one comparison cohort before recommending a pillar or angle.");
  }
  for (const basis of ["per_1000_views", "counts"] as const) {
    const posts = perf.topPosts.filter((p) => p.comparisonBasis === basis);
    if (!posts.length) continue;
    lines.push("", basis === "counts" ? "Count-only samples (exposure unavailable or zero):" : "Samples with impressions (events per 1,000 views):");
    for (const post of posts) {
      const tag = [post.pillar, post.angle].filter(Boolean).join(" / ");
      const rates = basis === "per_1000_views"
        ? `; rates: response ${metric(post.rates.response)}, amplification ${metric(post.rates.amplification)}, saves ${metric(post.rates.bookmarks)}` : "";
      lines.push(`- ${tag ? `[${tag}] ` : ""}${post.hook.slice(0, 200)} (likes ${post.likes}, responses ${post.response}, reposts ${post.reposts}, quotes ${metric(post.quotes)}, saves ${metric(post.bookmarks)}${rates})`);
    }
  }
  for (const [label, buckets] of [["pillars", perf.pillarRanking], ["angles", perf.angleRanking]] as const) {
    lines.push("", `Observed ${label} (coverage and support):`);
    for (const bucket of buckets.slice(0, 5)) {
      const status = bucket.recommendationSupported
        ? `supported hypothesis, ${bucket.recommendationBasis}` : "observation only";
      lines.push(`- ${bucket.key}: ${bucket.posts} posts; ${bucket.ratedPosts} with impressions, ${bucket.countOnlyPosts} count-only; quotes ${bucket.quotesMeasuredPosts}/${bucket.posts}, saves ${bucket.bookmarksMeasuredPosts}/${bucket.posts}; ${status}`);
      lines.push(`  rates per 1,000 views: response ${metric(bucket.rates.response)} (${bucket.ratedPosts} posts), amplification ${metric(bucket.rates.amplification)} (${bucket.amplificationRatedPosts} posts), saves ${metric(bucket.rates.bookmarks)} (${bucket.bookmarksRatedPosts} posts); count-only average observed interactions ${metric(bucket.avgCountOnlyEngagement)}`);
    }
  }
  return lines.join("\n");
}
