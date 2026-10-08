import type { Sql } from "postgres";
import type { AuthorEngagement } from "./ideation.js";
import {
  getSavedAuthorEngagement,
  SAVED_AUTHOR_LIMIT,
  SAVED_POSTS_PER_AUTHOR,
  type SavedEngagementArgs,
} from "./saved-author-engagement-db.js";

/** Topic radar retains unknown-count posts without ranking them as measured zero. */
export async function getXWatchlistAuthorEngagement(
  sql: Sql,
  args: SavedEngagementArgs,
): Promise<AuthorEngagement[]> {
  const authors = await getSavedAuthorEngagement(sql, args);
  return authors
    .filter((author) => author.observedPostCount >= args.minPosts)
    .slice(0, Math.min(args.limitAuthors, SAVED_AUTHOR_LIMIT))
    .map((author) => ({
      authorHandle: author.authorHandle,
      authorName: author.authorName,
      avgEngagement: author.avgEngagement,
      observedPostCount: author.observedPostCount,
      measuredPostCount: author.measuredPostCount,
      samplePosts: author.posts
        .slice(0, Math.min(args.samplePosts, SAVED_POSTS_PER_AUTHOR))
        .map(({ externalId, text, url, likes, replies, reposts }) => ({
          externalId,
          text,
          url,
          likes,
          replies,
          reposts,
        })),
    }));
}
