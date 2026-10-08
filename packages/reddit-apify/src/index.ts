// Reddit posts transport via Apify.
//
// Why: mirrors the LinkedIn intern's Apify client exactly so the Reddit worker app
// can call it the same way. Apify runs the scraper + proxies, so there are no
// Reddit cookies, no login, no session death — we just POST a subreddit + token
// and get its posts back.
//
// Read-only by design: this only FETCHES posts. The intern drafts for human
// approval and never posts to Reddit.
//
// Actor:
//   - subreddit-posts (parseforge~reddit-posts-comments-scraper): every post in a
//     subreddit by sort + time window, WITH each post's top-upvoted comments and
//     its image media. The fit for "watch a subreddit and draft Reddit-native
//     replies" — the intern reads the room (top comments) and can reply to the
//     most-upvoted comment, and reacts to the post's image via vision.

import { createApifyTransport } from "@noelle/runtime/apify-transport";
import type { ApifyRunReceipt } from "@noelle/runtime/apify-run-receipts";
import { readSourceCount, readSourceVoteScore, readSourceTimestamp, readSourceEpochTimestamp } from "@noelle/runtime/source-values";

// Apify slug form (username~name) — the run-sync endpoint accepts it, so there's
// no opaque hash to track. This actor returns posts + their top comments + media
// so the drafter can read the room and reply to the most-upvoted comment.
export const SUBREDDIT_POSTS_ACTOR_ID = "parseforge~reddit-posts-comments-scraper";

export class ApifyError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "ApifyError";
    this.status = status;
  }
}

export { checkApifyToken } from "@noelle/runtime/apify-token-health";
export type { ApifyTokenHealth } from "@noelle/runtime/apify-token-health";

/**
 * One comment on a post, from EITHER source: the Apify reddit-posts-comments
 * actor (normalizeRedditComment — supplies id + permalink) OR Reddit's free public
 * `.json` endpoint (fetchRedditPostComments — supplies neither). `body`, `score`,
 * and `author` are always present; `id` and `permalink` are OPTIONAL because only
 * the Apify source can provide them. A comment is only ACTUATABLE (can be replied
 * to under) when it carries BOTH id and permalink — the free-`.json` comments are
 * read-the-room context only. `body` is UNTRUSTED, attacker-authored text — the
 * drafter MUST fence it (never let it act as an instruction).
 */
export interface RedditComment {
  /** The comment text. UNTRUSTED — fence before showing it to an LLM. */
  body: string;
  /** Signed vote score; null when unknown. */
  score: number | null;
  /** Commenter handle. Bare (no "u/") from the Apify source, "u/…" from the free source. */
  author: string;
  /** Comment id with any leading "t1_" stripped. Apify source only (absent otherwise). */
  id?: string;
  /** Canonical permalink to the comment. Apify source only (absent otherwise). */
  permalink?: string;
}

export interface RedditPost {
  /** Reddit post id with any leading "t3_" stripped. Used as leads.external_id. */
  id: string;
  title: string;
  /** Self-post body text (from selfText/body); '' if a link post or empty. */
  body: string;
  /** Canonical reddit URL (https://www.reddit.com + permalink path). */
  url: string;
  /** The link target for a link post (the raw `url` field), when present. */
  externalUrl?: string;
  /** Subreddit name without the "r/" prefix. */
  subreddit: string;
  /** ISO 8601 (from the post timestamp); '' if unknown. */
  createdAt: string;
  score: number | null;
  upvoteRatio?: number;
  numComments: number | null;
  author: { username: string };
  /**
   * Post media image URLs (preview/gallery images, a direct image link, the
   * thumbnail), coalesced DEFENSIVELY from the actor's several media fields
   * (mirrors the LinkedIn client's extractImages). Absent on a text/link-only
   * post (the key is omitted, never an empty array), so a downstream
   * vision-caption step can `if (post.images)` and skip the LLM call.
   */
  images?: string[];
  /**
   * The post's most-upvoted comments (score desc, capped at commentsPerPost).
   * UNTRUSTED, attacker-authored text — fence it. Absent when the post has no
   * comments (key omitted, never an empty array).
   */
  topComments?: RedditComment[];
}

export interface CreateApifyRedditClientOpts {
  /** Apify API token. The only credential — no Reddit cookies. */
  token: string;
  /** Apify API base (default https://api.apify.com). */
  baseUrl?: string;
  /** Override the subreddit-posts actor id (default parseforge~reddit-posts-comments-scraper). */
  subredditPostsActorId?: string;
  /** Max wait for a synchronous actor run (ms). Default 120000. */
  timeoutMs?: number;
  /** Injectable fetch for tests. */
  fetchImpl?: typeof fetch;
}

export interface ApifyRedditClient {
  /** Independent logical-operation state, provided by rotating client facades. */
  isolateOperation?(): ApifyRedditClient;
  /** Final reported charges for the current operation, including failed runs. */
  drainRunReceipts?(): ApifyRunReceipt[];
  /** Legacy single drain; null when any run's actual charge is unknown. */
  drainLastRunUsd?(): number | null;
  /** Every post in a subreddit, by sort + time window. */
  subredditPosts(args: {
    subreddit: string;
    sort?: "new" | "hot" | "top" | "rising";
    time?: "hour" | "day" | "week" | "month" | "year" | "all";
    maxItems?: number;
    /** Precise client-side lower bound: drop posts older than this ISO time. */
    sinceISO?: string;
    /** How many top comments to request + keep per post (default 8). */
    commentsPerPost?: number;
  }): Promise<RedditPost[]>;
}

// Apify item shape (subset we read) — fields are best-effort/optional. The Reddit
// posts scraper returns posts with id/title/selfText (or body), an author handle,
// a subreddit, a permalink (relative path), a url (the link target on link posts),
// a created timestamp, plus score/upvoteRatio/numComments. We read defensively.
interface ApifyRedditItem {
  id?: string;
  name?: string; // the "t3_xxx" fullname, when id is bare
  title?: string;
  selfText?: string;
  selftext?: string;
  body?: string;
  text?: string;
  author?: string | { name?: string; username?: string };
  username?: string;
  subreddit?: string;
  subredditName?: string;
  permalink?: string;
  url?: string;
  link?: string;
  createdAt?: string | number;
  created?: string | number;
  createdUtc?: number;
  created_utc?: number;
  score?: unknown;
  ups?: unknown;
  upvoteRatio?: unknown;
  upvote_ratio?: unknown;
  numComments?: unknown;
  num_comments?: unknown;
  over18?: unknown;
  // Media — coalesced by extractImages. Names are best-effort/UNVERIFIED for this
  // actor, so we read several spellings and skip anything malformed.
  previewImages?: unknown;
  galleryData?: unknown;
  galleryImages?: unknown;
  mediaUrl?: unknown;
  thumbnail?: unknown;
  // Nested comments (the common case) — one of these carries an array of comments.
  comments?: unknown;
  topComments?: unknown;
  commentList?: unknown;
  // Separate-items mode: some actor runs emit comments as their own rows with a
  // dataType/type discriminator, grouped back under their parent post by the client.
  dataType?: unknown;
  type?: unknown;
}

// One raw comment — nested inside a post, or a standalone row in separate-items
// mode. All field names best-effort/UNVERIFIED; read defensively, never throw.
interface ApifyRedditComment {
  id?: unknown;
  commentId?: unknown;
  body?: unknown;
  text?: unknown;
  bodyText?: unknown;
  score?: unknown;
  upVotes?: unknown;
  ups?: unknown;
  author?: unknown;
  authorName?: unknown;
  permalink?: unknown;
  postUrl?: unknown;
  url?: unknown;
  // Parent linkage (separate-items mode): a t3_ post fullname or bare post id.
  link_id?: unknown;
  linkId?: unknown;
  postId?: unknown;
  parentPostId?: unknown;
  parentId?: unknown;
  dataType?: unknown;
  type?: unknown;
}
