// Thin XClient adapter over @steipete/bird's TwitterClient.
//
// Shared by:
//   - apps/x-intern (discovery + send workers — bulk reads + per-tick replies)
//   - apps/api-vm (synchronous send from POST /api/drafts/:id/send so the
//     dashboard knows whether the click actually posted to X before
//     returning a response)
//
// We used to hand-maintain X's GraphQL queryIds in x-graphql-ids.ts, which
// rotated on every web-client release and produced silent 404s on
// /UserTweets / /SearchTimeline. Bird ships a `runtimeQueryIds` store that
// fetches the current hashes at runtime from x.com, so callers no longer
// need a manual rotation step.

import { TwitterClient, type TweetData, type SearchResult } from "@steipete/bird";

import { readXSourceCount, readXSourceId, readXSourceTimestamp } from "./tweet-source-values.js";
import { XError, XAuthError, XRateLimitError, XLockError, XChallengeError, XWriteUncertainError } from "./errors.js";

// Re-export the error taxonomy + the official API write client so consumers get
// everything from "@noelle/x-client".
export * from "./errors.js";
export * from "./apiClient.js";
export * from "./refreshCoordinator.js";
export * from "./tweet-source-values.js";

export interface XTweet {
  id: string;
  text: string;
  created_at: string; // ISO
  /** `followers` is null when the X response didn't carry a count (unknown —
   *  graded as neutral downstream, never punished). */
  /**
   * `bio` is the author's profile description when the source carried one, else
   * null. The Apify actor does not reliably send it, so consumers must treat
   * null as UNKNOWN (fail open), never as "this person has no bio".
   */
  author: { handle: string; id: string; followers: number | null; bio?: string | null };
  url: string;
  /**
   * True when this tweet is a pure repost (native retweet) — the author shared
   * someone else's tweet verbatim with no commentary of their own. Replying to
   * one means replying to a stranger's words, so discovery drops them (even for
   * watchlist people). A quote-tweet (own commentary + a quoted tweet) is NOT a
   * repost and stays `false`.
   */
  is_repost: boolean;
  /**
   * True when this tweet is a REPLY to another tweet (it sits under someone
   * else's post / in a thread), as opposed to a fresh top-level post. Discovery
   * drops these when `excludeReplies` is set so the agent replies to ORIGINAL
   * posts, not to comments buried under a post. Both source adapters extract
   * numeric parent and conversation identifiers when present.
   */
  is_reply?: boolean;
  /** Numeric identifiers carried by the source, absent when unknown. */
  conversation_id?: string;
  in_reply_to_id?: string;
  /**
   * Post media image URLs (a photo, or the thumbnail for a video / animated
   * gif), pulled from the raw GraphQL tweet. Absent on a text-only tweet (the
   * field is omitted, never an empty array), so a downstream vision-caption step
   * can `if (tweet.images)` and skip the LLM call. Only present when the tweet
   * was fetched with `{ includeRaw: true }` (discovery does, for followers).
   */
  images?: string[];
  /**
   * Public engagement counts, when the source carried them. Used by the X ideation worker to rank net-new
   * VIRAL posts and to show "234 likes / 12 replies" on an inspiration ref. Each
   * is null when unknown — never zero-by-assumption, so a missing count is never
   * read as "this post flopped".
   */
  likes?: number | null;
  reposts?: number | null;
  replies?: number | null;
}

export interface XClient {
  verifyCredentials(): Promise<{ screen_name: string; id_str: string }>;
  userTweets(args: { handle: string; sinceISO?: string; limit?: number }): Promise<XTweet[]>;
  searchTimeline(args: { query: string; sinceISO?: string; limit?: number }): Promise<XTweet[]>;
  createTweet(args: { inReplyToId: string; text: string }): Promise<{ id: string; url: string }>;
  /** Best-effort like. Returns whether it landed; never throws. */
  likeTweet(tweetId: string): Promise<boolean>;
}

export interface CreateXClientOpts {
  ct0: string;
  authToken: string;
  /** Optional injection for tests; production passes a real TwitterClient. */
  client?: BirdLike;
}

/**
 * Minimal subset of TwitterClient that this adapter actually calls. Declared
 * structurally so tests can hand in a stub without depending on Bird's full
 * surface area.
 */
export interface BirdLike {
  // Bird returns the identity nested under `user` ({id, username, name}) — NOT
  // flat `userId`/`username`. Reading the wrong fields silently yields
  // "unknown" handles + a 0 id (the bug this type now prevents).
  getCurrentUser(): Promise<{
    success: boolean;
    user?: { id: string; username?: string; name?: string };
    error?: string;
  }>;
  getUserIdByUsername(username: string): Promise<{ success: boolean; userId?: string; error?: string }>;
  // `options.includeRaw` makes Bird attach the full GraphQL result on each
  // tweet's `_raw` — REQUIRED for follower-count extraction (Bird strips the
  // author down to {username,name} otherwise, so `_raw` is the only place the
  // count survives). Defaults to false in Bird, so we must pass it explicitly.
  getUserTweets(userId: string, count?: number, options?: { includeRaw?: boolean }): Promise<SearchResult>;
  search(query: string, count?: number, options?: { includeRaw?: boolean }): Promise<SearchResult>;
  reply(text: string, replyToTweetId: string): Promise<{ success: true; tweetId: string } | { success: false; error: string }>;
  like(tweetId: string): Promise<{ success: boolean; error?: string }>;
}

function toXTweet(t: TweetData): XTweet | null {
  if (!t || typeof t !== "object" || Array.isArray(t)) return null;
  const id = readXSourceId(t.id);
  if (!id || typeof t.text !== "string" || !t.text.trim() || typeof t.author?.username !== "string" || !t.author.username.trim()) return null;
  // A tweet we cannot date cannot be age-gated against the max-lead-age rule.
  // We DROP it rather than fabricate a timestamp: a faked "now" made months-old
  // posts look fresh and slipped past BOTH discovery's `since` window filter and
  // the classifier's 15-day recency cutoff (the Feb-24-tweet-in-the-inbox bug).
  const createdAt = extractCreatedAt(t);
  if (!createdAt) return null;
  const handle = t.author.username;
  // Photos/video thumbnails ride on the raw GraphQL tweet — omit the key on a
  // text-only tweet (never an empty array) so a downstream vision step can
  // `if (tweet.images)` and skip the LLM call.
  const images = extractImages(t);
  const relations = extractRelations(t);
  const legacies = rawTweetNodes(t).map((node) => node.legacy);
  return {
    id,
    text: t.text,
    created_at: createdAt,
    author: {
      handle,
      ...extractAuthorMetadata(t),
    },
    url: `https://x.com/${handle}/status/${id}`,
    likes: readXSourceCount(t.likeCount, ...legacies.map((legacy) => legacy?.favorite_count)),
    reposts: readXSourceCount(t.retweetCount, ...legacies.map((legacy) => legacy?.retweet_count)),
    replies: readXSourceCount(t.replyCount, ...legacies.map((legacy) => legacy?.reply_count)),
    is_repost: extractIsRepost(t),
    ...relations,
    ...(images.length > 0 ? { images } : {}),
  };
}

/**
 * Best-effort post-media image extraction from Bird's raw GraphQL tweet result.
 * X attaches media on the legacy block under `extended_entities.media[]`
 * (preferred — carries video info) or `entities.media[]`, each entry typed
 * "photo" | "video" | "animated_gif" with a `media_url_https`. For a photo that
 * URL is the image; for a video / animated_gif it is the thumbnail (X exposes no
 * separate poster field there), which is exactly the still we want a vision model
 * to caption. We read `_raw` across its known nestings (the post itself, or a
 * visibility-wrapped `tweet`/`result`), mirroring author metadata /
 * extractCreatedAt. Fully defensive: a missing / odd shape yields no images, and
 * we dedupe + keep http(s) URLs only. Empty unless the tweet carried `_raw`
 * (i.e. was fetched with `{ includeRaw: true }`).
 */
function extractImages(t: TweetData): string[] {
  type RawMedia = { type?: unknown; media_url_https?: unknown };
  type RawLegacy = {
    extended_entities?: { media?: unknown };
    entities?: { media?: unknown };
  };
  const legacies = rawTweetNodes(t).map((node) => node.legacy as RawLegacy | undefined);
  const out: string[] = [];
  for (const legacy of legacies) {
    if (!legacy) continue;
    const media = [legacy.extended_entities?.media, legacy.entities?.media]
      .flatMap((collection) => Array.isArray(collection) ? collection : []);
    for (const item of media as RawMedia[]) {
      // For photo|video|animated_gif, media_url_https is the still image (the
      // thumbnail for videos). Keep http(s) URLs only; dedupe.
      const url = item?.media_url_https;
      if (typeof url === "string" && /^https?:\/\//i.test(url) && !out.includes(url)) {
        out.push(url);
      }
    }
  }
  return out;
}

/**
 * Detect a pure repost (native retweet). The reliable signal lives on the raw
 * GraphQL `legacy` block: a retweet carries `retweeted_status_id_str` (or the
 * nested `retweeted_status_result`) pointing at the original tweet. We fall
 * back to the `"RT @"` text prefix for result shapes that don't carry `_raw`.
 *
 * Quote-tweets are deliberately NOT reposts: they expose `quoted_status_id_str`
 * (not `retweeted_status_*`) and the text is the author's own commentary, so
 * none of these checks fire and they survive the discovery filter.
 */
