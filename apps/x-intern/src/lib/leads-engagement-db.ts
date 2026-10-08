import type { Sql } from "postgres";
import type { AuthorEngagement, SamplePost } from "./engagement-analyst.js";
import {
  getSavedAuthorEngagement,
  SAVED_AUTHOR_LIMIT,
  SAVED_POSTS_PER_AUTHOR,
  type SavedEngagementArgs,
} from "./saved-author-engagement-db.js";

/** Rank only complete measured post samples; optional intelligence fails soft. */
export async function getWatchlistAuthorEngagement(
  sql: Sql,
  args: SavedEngagementArgs,
): Promise<AuthorEngagement[]> {
  try {
    const authors = await getSavedAuthorEngagement(sql, args);
    return authors
      .filter(
        (author) =>
          author.measuredPostCount >= args.minPosts &&
          author.avgEngagement !== null &&
          author.totalEngagement !== null,
      )
      .slice(0, Math.min(args.limitAuthors, SAVED_AUTHOR_LIMIT))
      .map((author) => ({
        authorHandle: author.authorHandle,
        authorId: author.authorId,
        authorName: author.authorName,
        authorHeadline: null,
        postCount: author.measuredPostCount,
        observedPostCount: author.observedPostCount,
        avgEngagement: author.avgEngagement!,
        totalEngagement: author.totalEngagement!,
        samplePosts: author.posts
          .filter((post) => post.engagement !== null)
          .slice(0, Math.min(args.samplePosts, SAVED_POSTS_PER_AUTHOR))
          .map(
            (post) =>
              ({
                externalId: post.externalId,
                text: post.text,
                url: post.url,
                likes: post.likes!,
                replies: post.replies!,
                reposts: post.reposts!,
              }) satisfies SamplePost,
          ),
      }));
  } catch {
    return [];
  }
}
