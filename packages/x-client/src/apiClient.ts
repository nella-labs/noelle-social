import { readXSourceId } from "./tweet-source-values.js";
// Official X API v2 WRITE client — the path Vega uses to auto-post posts +
// replies. Distinct from the cookie/bird path in index.ts (which can only
// reply). Bird literally cannot post a top-level tweet, so original posts ALWAYS
// go through here. Errors normalise into the SAME XError taxonomy as the cookie
// path, so the send/publish workers catch them uniformly.
//
// Safety:
//  - The writable client can only be CONSTRUCTED for an enabled x_intern
//    (`assertXWriteAllowed`) — a draft-only agent throws at construction.
//  - Top-level posts (no inReplyToId) are stripped of external links here, the
//    single chokepoint, so no caller can post a link.

import { createHmac, randomBytes } from "node:crypto";
import { XError, XAuthError, XRateLimitError, XLockError, XWriteUncertainError } from "./errors.js";
import { stripExternalLinksForPost } from "@noelle/runtime";

const X_API_BASE = "https://api.twitter.com/2";
const X_OAUTH_TOKEN_URL = "https://api.twitter.com/2/oauth2/token";
// v1.1 media upload host — the simple (single-request) endpoint is the reliable
// path for images (PNG/JPG/GIF/WEBP). It accepts BOTH OAuth 1.0a and OAuth2
// user-context auth, so it mirrors the tweet path's auth branch. Chunked
// (INIT/APPEND/FINALIZE + STATUS polling) is only needed for video — a follow-up.
const X_MEDIA_UPLOAD_URL = "https://upload.twitter.com/1.1/media/upload.json";
// X caps a single tweet at 4 images.
const MAX_TWEET_MEDIA = 4;

/** The owning agent is not an enabled x_intern — it may never reach the write path. */
export class XWriteForbiddenError extends XError {
  constructor(message = "x write not permitted for this agent") {
    super(message, 403);
    this.name = "XWriteForbiddenError";
  }
}

/** X rejected the content as a duplicate. Non-retryable — the content is effectively already up. */
export class XDuplicateError extends XError {
  constructor(message = "x duplicate content") {
    super(message, 403);
    this.name = "XDuplicateError";
  }
}

/**
 * X refused the REPLY itself — "Reply to this conversation is not allowed
 * because you have not been mentioned or otherwise engaged" and its variants.
 * Fires per-conversation when the author limited who can reply, but ALSO fires
 * on EVERY reply when the account/app has lost reply permission (the 2026-07-11
 * storm: 65/65 identical 403s terminally errored 118 approvals in 2 minutes).
 * The send worker treats one as row-level and a consecutive run as systemic
 * (halt + alert), so it must be distinguishable from a generic 403.
 */
export class XReplyRestrictedError extends XError {
  constructor(message = "x reply not allowed for this conversation") {
    super(message, 403);
    this.name = "XReplyRestrictedError";
  }
}

export interface XApiTokens {
  accessToken: string;
  refreshToken?: string;
  /** epoch ms when accessToken expires (optional). */
  expiresAt?: number;
}

/**
 * Perform ONE raw OAuth2 refresh-token grant against X and return the parsed,
 * rotated tokens. THROWS (XAuthError) on any non-2xx / malformed response — it
 * never returns a partial/false result, so a coordinator can treat a throw as
 * "roll back, do not persist".
 */
export type PerformHttpRefresh = (refreshToken: string) => Promise<XApiTokens>;

/**
 * Serializes token refresh across processes. Given a `performHttpRefresh`, the
 * coordinator is responsible for (a) ensuring only one process calls X at a time
 * for this account, (b) re-reading the CURRENT persisted refresh token, (c)
 * persisting the rotation atomically, and (d) returning the fresh tokens. When
 * set, the client does NOT also call `onTokensRefreshed` — the coordinator has
 * already persisted. See `makeRefreshCoordinator` in ./refreshCoordinator.
 */
export type RefreshCoordinator = (
  performHttpRefresh: PerformHttpRefresh,
) => Promise<XApiTokens>;

export interface OAuth1aCreds {
  consumerKey: string;
  consumerSecret: string;
  accessToken: string;
  accessTokenSecret: string;
}

export interface XApiClientOpts {
  /** OAuth2 user-context tokens (Bearer + refresh). Provide this OR `oauth1a`. */
  tokens?: XApiTokens;
  /** OAuth 1.0a user-context creds (HMAC-SHA1 signed per request). Provide this OR `tokens`. */
  oauth1a?: OAuth1aCreds;
  // Identity gate — checked at construction.
  role: string;
  sendEnabled: boolean;
  xApiWriteEnabled: boolean;
  // OAuth2 refresh-token grant (omit to disable refresh).
  clientId?: string;
  clientSecret?: string;
  /** Persist rotated tokens (DB write-back). */
  onTokensRefreshed?: (t: XApiTokens) => Promise<void> | void;
  /**
   * Serialize + persist refresh across processes (advisory-locked). When set,
   * this REPLACES the inline refresh + `onTokensRefreshed` path: the coordinator
   * makes the X call under a lock and persists the rotation itself. Prevents the
   * single-use refresh-token race between the send worker, content-publish
   * worker, and the manual /send route.
   */
  refreshCoordinator?: RefreshCoordinator;
  /** Handle for building the result URL (optional). */
  handle?: string | null;
  /** Injectable fetch for tests. */
  fetchFn?: typeof fetch;
  /** Per-request deadline, including response body reads; defaults to 20 seconds. */
  requestTimeoutMs?: number;
}

/**
 * One tweet's public engagement, from GET /2/tweets `public_metrics`. Unlike the
 * Apify read path (likes/reposts/replies only), the official API also exposes
 * `impression_count` — the real reach number the Performance tab needs. `views`
 * and `bookmarks`/`quotes` are null when X omitted them; an optional count is
 * never assumed zero.
 */
export interface TweetMetrics {
  id: string;
  views: number | null;
  likes: number;
  reposts: number;
  replies: number;
  quotes: number | null;
  bookmarks: number | null;
}

/**
 * The authed operator's OWN account, from GET /2/users/me `public_metrics`.
 *
 * This is the only follower number Noelle can trust about the operator. The
 * Apify read path only ever exposed a follower count as a by-product of pulling
 * a *published post* — so it went dark whenever nothing had been published
 * recently, and it dies outright when the Apify token pool is exhausted. This
 * call needs neither: it asks X directly who the token belongs to.
 *
 * A count X omitted stays null — never assumed zero, because "0 followers" is a
 * claim the drafter would repeat out loud.
 */
export interface OwnAccount {
  id: string;
  handle: string;
  displayName: string | null;
  followers: number | null;
  following: number | null;
  posts: number | null;
}

export interface XWriteClient {
  /**
   * Post a top-level tweet (no inReplyToId) or a reply. Top-level posts are
   * stripped of external links; replies keep them. `mediaIds` (already uploaded
   * via `uploadMedia`) attach as `media.media_ids` — up to 4 images.
   */
  postTweet(args: {
    text: string;
    inReplyToId?: string;
    mediaIds?: string[];
  }): Promise<{ id: string; url: string }>;
  /**
   * Read the authed operator's own account + follower/following/post counts
   * (GET /2/users/me). A read, not a write — costs no write budget. Throws on a
   * transport/auth error (normalised to the XError taxonomy); callers treat a
   * failure as "unknown", never as zero.
   */
  getMyAccount(): Promise<OwnAccount>;
  /**
   * Read public engagement for up to 100 tweet ids per call (chunked internally
   * above that). A read, not a write — same account tokens, no cap. Tweets X
   * couldn't return (deleted / protected) are silently absent from the result;
   * only a transport/auth error throws (normalised to the XError taxonomy).
   */
  getTweetMetrics(ids: string[]): Promise<TweetMetrics[]>;
  /**
   * Upload one image (simple, single-request) and return its `media_id_string`.
   * The returned id is usable immediately for `postTweet({ mediaIds })` by the
   * SAME authed user. Errors normalise into the same XError taxonomy as posting.
   */
  uploadMedia(args: { bytes: Uint8Array; mimeType: string }): Promise<{ mediaId: string }>;
  handle: string | null;
}

/** X's GET /2/tweets accepts at most 100 ids per request. */
const TWEETS_LOOKUP_MAX = 100;

function measuredCount(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
