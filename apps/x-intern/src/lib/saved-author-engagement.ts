import { readSourceCount } from "@noelle/runtime/source-values";

export const SAVED_AUTHOR_LIMIT = 500;
export const SAVED_POSTS_PER_AUTHOR = 100;

export interface SavedEngagementArgs {
  agentInstanceId: string;
  windowDays: number;
  limitAuthors: number;
  samplePosts: number;
  minPosts: number;
}

export interface SavedPost {
  externalId: string;
  text: string;
  url: string | null;
  likes: number | null;
  replies: number | null;
  reposts: number | null;
  engagement: number | null;
}

export interface SavedAuthorEngagement {
  authorHandle: string;
  authorId: string | null;
  authorName: string | null;
  observedPostCount: number;
  measuredPostCount: number;
  avgEngagement: number | null;
  totalEngagement: number | null;
  posts: SavedPost[];
}

export interface SavedPostRow {
  author_handle: string;
  author_id: string | null;
  author_name: string | null;
  external_id: string;
  text: string;
  url: string | null;
  likes: string | null;
  replies: string | null;
  reposts: string | null;
}

/** Normalize and rank only complete, safely represented captured measurements. */
export function rankSavedAuthorRows(rows: SavedPostRow[]): SavedAuthorEngagement[] {
  const authors = new Map<string, SavedAuthorEngagement>();
  for (const row of rows) {
    let author = authors.get(row.author_handle);
    if (!author) {
      author = {
        authorHandle: row.author_handle,
        authorId: row.author_id,
        authorName: row.author_name || null,
        observedPostCount: 0,
        measuredPostCount: 0,
        avgEngagement: null,
        totalEngagement: null,
        posts: [],
      };
      authors.set(row.author_handle, author);
    }
    const likes = readSourceCount(row.likes);
    const replies = readSourceCount(row.replies);
    const reposts = readSourceCount(row.reposts);
    const sum =
      likes !== null && replies !== null && reposts !== null ? likes + replies + reposts : null;
    const engagement = sum !== null && Number.isSafeInteger(sum) ? sum : null;
    author.posts.push({
      externalId: row.external_id,
      text: row.text,
      url: row.url,
      likes,
      replies,
      reposts,
      engagement,
    });
    author.observedPostCount++;
    if (engagement !== null) author.measuredPostCount++;
  }
  for (const author of authors.values()) {
    if (author.measuredPostCount) {
      const total = author.posts.reduce((sum, post) => sum + (post.engagement ?? 0), 0);
      if (Number.isSafeInteger(total)) {
        author.totalEngagement = total;
        author.avgEngagement = total / author.measuredPostCount;
      }
    }
    // Stable sort preserves the database's latest-first order for equal counts.
    author.posts.sort((a, b) => {
      if (a.engagement === null) return b.engagement === null ? 0 : 1;
      if (b.engagement === null) return -1;
      return b.engagement - a.engagement;
    });
  }
  return [...authors.values()].sort((a, b) => {
    if (a.avgEngagement === null) {
      return b.avgEngagement === null ? a.authorHandle.localeCompare(b.authorHandle) : 1;
    }
    if (b.avgEngagement === null) return -1;
    return b.avgEngagement - a.avgEngagement || a.authorHandle.localeCompare(b.authorHandle);
  });
}
