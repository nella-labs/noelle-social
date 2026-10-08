import type { Fragment, Sql } from "postgres";
import { measuredCountMean, readSourceCount } from "./sourceValues.js";

/** A total engagement measurement requires both counts and a representable sum. */
export function corpusEngagement(likes: unknown, comments: unknown): number | null {
  const a = readSourceCount(likes);
  const b = readSourceCount(comments);
  return a !== null && b !== null && Number.isSafeInteger(a + b) ? a + b : null;
}

/** Equivalent SQL measurement rule for the corpus query's fixed `p` alias. */
export function corpusEngagementSql(sql: Sql): Fragment {
  return sql`case when p.like_count >= 0 and p.comment_count >= 0
    and p.like_count::numeric + p.comment_count::numeric <= ${Number.MAX_SAFE_INTEGER}
    then p.like_count + p.comment_count end`;
}

function measuredMean(values: unknown[]): number | null {
  const mean = measuredCountMean(values);
  return mean === null ? null : Math.round(mean * 100) / 100;
}

/** Unknown counts never dilute averages or qualify an unmeasured top sample. */
export function computePerfRollup(corpus: Array<{ externalId: string; likeCount: number | null; commentCount: number | null }>) {
  const measured = corpus.map(item => ({ ...item, likes: readSourceCount(item.likeCount) }))
    .filter((item): item is typeof item & { likes: number } => item.likes !== null);
  return {
    avgLikeCount: measuredMean(corpus.map(item => item.likeCount)),
    avgCommentCount: measuredMean(corpus.map(item => item.commentCount)),
    postsAnalyzed: corpus.length,
    samplePostIds: measured.sort((a, b) => b.likes - a.likes).slice(0, 8).map(item => item.externalId),
  };
}
