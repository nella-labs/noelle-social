import type { Sql } from "postgres";

// Queries for the Reddit intern's watchlist table:
//   - noelle.reddit_watchlist — the subreddits Orion watches.
//
// Orion is subreddit-centric (not person-centric like Lyra): discovery sweeps
// each watched subreddit's recent posts via Apify, the classifier grades them,
// and the drafter writes a reply for the in-ICP ones. There is no profiler, no
// person profiles, no keyword-search lane, and no intro-DM lane.

export interface WatchlistSubreddit {
  id: string;
  /** Subreddit name without the "r/" prefix (e.g. "SaaS"). */
  subreddit: string;
  /** Optional per-subreddit engagement steer for the drafter. */
  objective: string | null;
  /** Skip posts whose score is below this before they become leads. 0 = no floor. */
  minScore: number;
  /** ISO timestamp the subreddit was added — discovery only ingests posts on/after. */
  addedAt: string;
}

/**
 * Every subreddit on the instance's Reddit watchlist. Drives discovery (fetch
 * each subreddit's recent posts). Oldest-added first (stable order).
 */
export async function getWatchlistSubreddits(
  sql: Sql,
  instanceId: string,
): Promise<WatchlistSubreddit[]> {
  const rows = await sql<
    {
      id: string;
      subreddit: string;
      objective: string | null;
      min_score: number | null;
      added_at: string;
    }[]
  >`
    select id, subreddit, objective, min_score, added_at
    from noelle.reddit_watchlist
    where agent_instance_id = ${instanceId}
    order by added_at asc
  `;
  return rows.map((r) => ({
    id: r.id,
    subreddit: r.subreddit,
    objective: r.objective,
    minScore: r.min_score ?? 0,
    addedAt: r.added_at,
  }));
}
