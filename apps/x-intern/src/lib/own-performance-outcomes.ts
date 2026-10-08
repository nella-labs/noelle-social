/** Counts from one coherent measurement; omitted optional outcomes are unknown. */
export interface OwnPerfInputRow {
  externalId: string;
  hook: string | null;
  pillar: string | null;
  angle: string | null;
  likes: number;
  reposts: number;
  replies: number;
  views?: number | null;
  quotes?: number | null;
  bookmarks?: number | null;
}

export type OutcomeComparison = "per_1000_views" | "counts";

/** Observed events per 1,000 views, not probabilities or ranking weights. */
export interface OutcomeRates {
  engagement: number | null;
  response: number | null;
  amplification: number | null;
  bookmarks: number | null;
}

export interface OwnPerfPost {
  externalId: string;
  hook: string;
  pillar: string | null;
  angle: string | null;
  /** Likes + replies + reposts + known quotes; bookmarks remain separate. */
  engagement: number;
  likes: number;
  reposts: number;
  replies: number;
  views: number | null;
  quotes: number | null;
  bookmarks: number | null;
  response: number;
  /** Reposts plus known quotes; inspect quotes to identify incomplete coverage. */
  amplification: number;
  comparisonBasis: OutcomeComparison;
  rates: OutcomeRates;
}

function count(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.min(Number.MAX_SAFE_INTEGER, Math.floor(value)) : null;
}

function perThousand(events: number | null, views: number | null): number | null {
  return events != null && views != null && views > 0 ? events / views * 1000 : null;
}

export function observeOwnPost(row: OwnPerfInputRow): OwnPerfPost {
  const likes = count(row.likes) ?? 0;
  const reposts = count(row.reposts) ?? 0;
  const replies = count(row.replies) ?? 0;
  const quotes = count(row.quotes);
  const bookmarks = count(row.bookmarks);
  const views = count(row.views);
  const amplification = reposts + (quotes ?? 0);
  const engagement = likes + replies + amplification;
  return {
    externalId: row.externalId,
    hook: (row.hook ?? "").replace(/\s+/g, " ").trim(),
    pillar: row.pillar,
    angle: row.angle,
    likes, reposts, replies, quotes, bookmarks, views,
    response: replies, amplification, engagement,
    comparisonBasis: views != null && views > 0 ? "per_1000_views" : "counts",
    rates: {
      engagement: perThousand(engagement, views),
      response: perThousand(replies, views),
      amplification: perThousand(quotes == null ? null : amplification, views),
      bookmarks: perThousand(bookmarks, views),
    },
  };
}

/** Each outcome uses only paired exposures on posts measuring that outcome. */
export function aggregateOutcomeRates(posts: OwnPerfPost[]): OutcomeRates {
  const rate = (pick: (p: OwnPerfPost) => number | null): number | null => {
    let events = 0;
    let views = 0;
    for (const post of posts) {
      const value = pick(post);
      if (value == null || post.views == null || post.views <= 0) continue;
      events += value;
      views += post.views;
    }
    return perThousand(views > 0 ? events : null, views);
  };
  return {
    engagement: rate((p) => p.engagement),
    response: rate((p) => p.response),
    amplification: rate((p) => p.quotes == null ? null : p.amplification),
    bookmarks: rate((p) => p.bookmarks),
  };
}

/** Cohort order is presentation order; counts and rates are never cross-ranked. */
export function compareOwnPosts(a: OwnPerfPost, b: OwnPerfPost): number {
  if (a.comparisonBasis !== b.comparisonBasis) return a.comparisonBasis === "per_1000_views" ? -1 : 1;
  const metric = (p: OwnPerfPost) => p.comparisonBasis === "per_1000_views" ? p.rates.engagement ?? 0 : p.engagement;
  return metric(b) - metric(a) || a.externalId.localeCompare(b.externalId);
}
