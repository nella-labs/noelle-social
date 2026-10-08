// X (twitter.com) reads via Apify (actor: X_SCRAPER_ACTOR_ID below).
//
// Why: cookie-based reads (@steipete/bird over ct0 + auth_token) put the X
// account at lock/suspension risk — read velocity is the #1 ban trigger, and a
// flagged read session also kills the write session. The Apify actor
// runs on Apify's own proxies and needs NO X login: there are no cookies, no
// fingerprint, no account to lock. So discovery reads here; writes (replies +
// likes) still go through @noelle/x-client over authed cookies, because the
// scraper is read-only and cannot post (the deliberate read/write split).
//
// This mirrors @noelle/linkedin-apify: a thin POST to Apify's run-sync endpoint
// that returns the actor's dataset items, normalised to the XTweet shape the
// discovery worker already consumes.
//
// Bonus: the actor returns author.followers directly, so the brittle `_raw`
// GraphQL follower/timestamp extraction the bird path needed disappears here.

import { readXSourceCount as asCount, readXSourceId as asPostId, readXSourceTimestamp, type XTweet } from "@noelle/x-client";
import { ApifyXError } from "./apify-error.js";
import { createApifyTransport } from "@noelle/runtime/apify-transport";
import type { ApifyResultCoverage, ApifyRunReceipt } from "@noelle/runtime/apify-run-receipts";

export type { XTweet };
export { ApifyXError };
export type { ApifyResultCoverage, ApifyRunReceipt };

const DEFAULT_BASE_URL = "https://api.apify.com";
// kaitoeasyapi/twitter-x-data-tweet-scraper-pay-per-result-cheapest — addressed by
// its username~name slug, which the run-sync endpoint accepts.
//
// Migrated off apidojo/twitter-scraper-lite on 2026-06-23: that actor silently
// flipped to returning {demo:true} placeholder items for Apify FREE-plan tokens
// (real data now requires a PAID Apify plan). The runs still succeed (HTTP 201)
// and still charge, but every item normalises away — which starved X discovery
// with zero errors (scanned:0 forever). kaito returns REAL tweets on the same
// free tokens, pay-per-result, with a near-identical item shape. The constant
// name is kept generic so a future actor swap is a one-line value change.
export const X_SCRAPER_ACTOR_ID =
  "kaitoeasyapi~twitter-x-data-tweet-scraper-pay-per-result-cheapest";
// Bare slug recorded as the spend `model` key — see runtime/apifyPrices.ts.
export const X_SCRAPER_ACTOR = "twitter-x-data-tweet-scraper";

// Follower/following scraper — the PERSON-discovery source.
//
// Deliberately the same publisher (kaitoeasyapi) as the tweet actor above,
// because that is the one proven to return REAL data on Apify FREE-plan tokens.
// The obvious feature-fit alternative (apidojo/twitter-user-scraper, which does
// true keyword→user search) is the same vendor this repo migrated OFF on
// 2026-06-23 for silently serving {demo:true} placeholders to free tokens while
// still charging — see the note above. On a free plan that trade is not worth
// re-taking for a load-bearing lane.
//
// Pay-per-result at ~$0.15/1K users, no login/cookies and no proxy setup, and
// each record carries the BIO — which is what the ICP gate qualifies on.
export const X_FOLLOWER_ACTOR_ID = "kaitoeasyapi~premium-x-follower-scraper-following-data";
/** Bare slug recorded as the spend `model` key — see runtime/apifyPrices.ts. */
export const X_FOLLOWER_ACTOR = "premium-x-follower-scraper";

function boundedLimit(value: number, maximum: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum) {
    throw new ApifyXError(`${name} must be an integer between 0 and ${maximum}`, 400);
  }
  return value;
}

export { checkApifyToken } from "@noelle/runtime/apify-token-health";
export type { ApifyTokenHealth } from "@noelle/runtime/apify-token-health";

/**
 * Result of one actor run. `resultCount` is the raw item count Apify returned
 * (before normalisation/dedup), which drives the per-result spend metering — the
 * normalised `tweets` array may be shorter (dropped retweets-of-self dups, undated
 * posts, or items outside the since-window).
 */
export interface ApifyXRunResult extends ApifyResultCoverage {
  tweets: XTweet[];
}

export interface ApifyXClient {
  /** Independent logical-operation state, provided by rotating client facades. */
  isolateOperation?(): ApifyXClient;
  /** Bounded receipts for this operation, including paid attempts whose dataset failed. */
  drainRunReceipts?(): ApifyRunReceipt[];
  /**
   * Real USD cost (`usageTotalUsd`) of the most recent successful run, reset to
   * null on read. The rotating client reads this right after each call to meter
   * spend from Apify's own figure; null means the run object carried no usage, so
   * the caller should fall back to the per-result estimate. Optional so existing
   * hand-built client mocks keep type-checking.
   */
  drainLastRunUsd?(): number | null;
  /**
   * Recent tweets from one handle's timeline (the watchlist lane). Since the
   * fetch rides the `from:` SEARCH operator, the exclude flags + sinceISO are
   * also applied server-side (`-filter:replies` / `-filter:nativeretweets` /
   * `since_time:`) — the actor bills per returned item, so anything excluded
   * here is an item never paid for. Client-side filtering stays as the backstop.
   */
  userTweets(args: {
    handle: string;
    limit?: number;
    sinceISO?: string;
    excludeReplies?: boolean;
    excludeRetweets?: boolean;
  }): Promise<ApifyXRunResult>;
  /** Keyword/operator search (the keyword lane). `query` carries X's native search operators. */
  searchTimeline(args: { query: string; limit?: number; sinceISO?: string }): Promise<ApifyXRunResult>;
  /**
   * The replies on a conversation (thread) by its root tweet id — the drafter's
   * "read the room" fetch. For a top-level post the lead's external_id IS the
   * conversation root id, so no extra lookup is needed. Reuses the SAME
   * pay-per-result actor as discovery via X's `conversation_id:` search operator
   * (~$0.00025/reply). Returns replies ranked by engagement (likes) desc, with the
   * root tweet and (optionally) the operator's own replies excluded. The caller
   * is responsible for fail-open handling — this throws like userTweets/searchTimeline.
   */
  conversationReplies(args: {
    conversationId: string;
    limit?: number;
    /** Operator handle to exclude, so the drafter never mirrors its own past replies. */
    excludeHandle?: string;
  }): Promise<ApifyXRunResult>;
  /**
   * PERSON discovery: the followers (and/or followings) of seed accounts.
   *
   * This is the X answer to Lyra's profile-search feeder. X has no keyword→user
   * search actor we can trust on a free plan, but "who follows this account" is
   * a STRONGER ICP signal than a bio keyword match anyway: the operator picks a
   * seed account that their ideal customer already follows, and the follower
   * list is that audience.
   *
   * Every record carries the bio, which is what the ICP gate qualifies on.
   * Throws like the other methods; the caller owns fail-open handling.
   */
  scrapeFollowers(args: {
    /** Seed handles (@-stripped). Their audience becomes the candidate pool. */
    seedHandles: string[];
    /** Hard ceiling on users returned. The actor's own minimum is 200. */
    maxUsers: number;
    /** Pull the seeds' FOLLOWERS (default) and/or the accounts they follow. */
    getFollowers?: boolean;
    getFollowing?: boolean;
  }): Promise<{ people: XCandidatePerson[] } & ApifyResultCoverage>;
}

/** One person surfaced by the follower scrape, normalised to Vega's shape. */
export interface XCandidatePerson {
  /** @-stripped, lowercased. */
  handle: string;
  /** Numeric X user id when present — stable across a handle rename. */
  id: string | null;
  displayName: string | null;
  /** Profile bio. null when absent/blank — the ICP gate treats null as unknown. */
  bio: string | null;
  followers: number | null;
}

export interface CreateApifyXClientOpts {
  /** Apify API token. The only credential — no X cookies. */
  token: string;
  /** Override the actor id (default X_SCRAPER_ACTOR_ID). */
  actorId?: string;
  /** Apify API base (default https://api.apify.com). */
  baseUrl?: string;
  /** Max wait for a synchronous actor run (ms). Default 120000. */
  timeoutMs?: number;
  /** Injectable fetch for tests. */
  fetchImpl?: typeof fetch;
}

// Apify item shape (subset we read) — all fields best-effort/optional.
interface ApifyMedia {
  type?: string;
  media_url_https?: string;
  media_url?: string;
}
interface ApifyTweetItem {
  // kaito tags real posts type:"tweet" and emits type:"mock_tweet" placeholders
  // for unsupported inputs (e.g. twitterHandles); demo items are {demo:true} with
  // no type. We keep only real tweets — see normalizeTweet's type guard.
  type?: string;
  demo?: boolean;
  id?: string | number;
  url?: string;
  twitterUrl?: string;
  text?: string;
  createdAt?: string;
  isRetweet?: boolean;
  // kaito marks a native retweet by populating retweeted_tweet (it has no
  // isRetweet flag); presence of either means "repost" → dropped by discovery.
  retweeted_tweet?: unknown;
  // Reply markers. Actor versions disagree on the field name, so asIsReply reads
  // each defensively; the conversationId heuristic (≠ this tweet's id) is the
  // most reliable fallback (a reply's conversationId is the THREAD ROOT's id).
  isReply?: boolean;
  inReplyToId?: string | number;
  inReplyToStatusId?: string | number;
  in_reply_to_status_id_str?: string;
  inReplyToUserId?: string | number;
  conversationId?: string | number;
  conversation_id?: string | number;
  // Engagement counts. Actor versions disagree on casing/keys (kaito emits
  // likeCount/retweetCount/replyCount; older/apidojo runs emit favorite_count/
  // retweet_count/reply_count, sometimes a flat `likes`). asCount reads each
  // variant defensively; absent ⇒ null (unknown, never 0).
  likeCount?: unknown;
  favoriteCount?: unknown;
  favorite_count?: unknown;
  likes?: unknown;
  retweetCount?: unknown;
  retweet_count?: unknown;
  replyCount?: unknown;
  reply_count?: unknown;
  // Media nestings vary by actor version; we read each defensively (see asImages).
  extendedEntities?: { media?: ApifyMedia[] };
  entities?: { media?: ApifyMedia[] };
  media?: Array<ApifyMedia | string>;
  author?: {
    userName?: string;
    id?: string | number;
    followers?: unknown;
    name?: string;
    // Author bio. The actor's key varies by version and it is NOT always sent,
    // so every plausible spelling is read defensively and an absent bio stays
    // null (never ""). Consumed by the ICP author gate, which fails OPEN on a
    // null bio precisely because "the actor didn't send it" is the common case.
    description?: unknown;
    bio?: unknown;
    rawDescription?: unknown;
  };
}

/**
 * Author bio: the first USABLE candidate, not the first DEFINED one. `??` only
 * skips null/undefined, so a present-but-empty `description: ""` (or a
 * non-string) would block the alternate spellings entirely and yield null even
 * when a real bio sat in `rawDescription`. Mirrors asCount's first-usable shape.
 */
function asBio(...candidates: unknown[]): string | null {
  for (const c of candidates) {
    if (typeof c !== "string") continue;
    const t = c.trim();
    if (t.length > 0) return t;
  }
  return null;
}

/** First candidate that is a non-blank string, else null. */
function firstString(...candidates: unknown[]): string | null {
  for (const c of candidates) {
    if (typeof c !== "string") continue;
    const t = c.trim();
    if (t.length > 0) return t;
  }
  return null;
}

/**
 * Best-effort post-media image URLs (photo, or a video/gif thumbnail) from the
 * actor item. The lite actor exposes media under a few different keys depending on
 * version, so we read extendedEntities/entities/media defensively. Returns
 * undefined (never []) when there's none, so the discovery payload omits the field
 * and a downstream vision-caption step can `if (tweet.images)` — matching the bird
 * path's contract.
 */
function asImages(item: ApifyTweetItem): string[] | undefined {
  const raw: unknown[] = [item.extendedEntities?.media, item.entities?.media, item.media]
    .flatMap((collection) => Array.isArray(collection) ? collection : []);
  const urls = raw
    .map((media) => typeof media === "string" ? media :
      media && typeof media === "object" ? firstString((media as ApifyMedia).media_url_https, (media as ApifyMedia).media_url) : null)
    .filter((url): url is string => typeof url === "string" && /^https?:\/\//i.test(url));
  const deduped = Array.from(new Set(urls));
  return deduped.length > 0 ? deduped : undefined;
}

/**
 * Best-effort "is this a reply?" detection. A reply sits under another tweet
 * (in a thread / under someone's post); discovery drops these when
 * `excludeReplies` is set so the agent answers ORIGINAL posts, not comments.
 *
 * Reads, in order of confidence:
 *   1. an explicit `isReply` boolean,
 *   2. any in-reply-to id field (top-level tweet id it answers),
 *   3. `conversationId` present AND ≠ this tweet's id — for a top-level post the
 *      conversation root IS the tweet, so they're equal; for a reply the root is
 *      a different (earlier) tweet, so they differ. This catches replies even
 *      when the actor omits the explicit fields.
 * Returns false when nothing indicates a reply (the safe default — a real post
 * is never mis-dropped).
 */
function asIsReply(item: ApifyTweetItem, id: string): boolean {
  if (item.isReply === true) return true;
  if (asPostId(item.inReplyToId, item.inReplyToStatusId, item.in_reply_to_status_id_str)) return true;
  const conversation = asPostId(item.conversationId, item.conversation_id);
  return conversation !== null && conversation !== id;
}

export function normalizeTweet(input: unknown): XTweet | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const item = input as ApifyTweetItem;
  // Drop kaito's demo/mock placeholders (type:"mock_tweet" or {demo:true}). Real
  // posts are type:"tweet"; older actors omit type entirely, so only reject a
  // present-and-non-"tweet" type rather than requiring it.
  if (item.demo === true) return null;
  if (item.type != null && item.type !== "tweet") return null;
  const id = asPostId(item.id);
  const text = firstString(item.text);
  const handle = firstString(item.author?.userName)?.replace(/^@/, "") ?? "";
  if (!id || !text || !handle) return null;
  const createdAt = readXSourceTimestamp(item.createdAt);
  if (!createdAt) return null;
  const images = asImages(item);
  const conversation = asPostId(item.conversationId, item.conversation_id);
  const parent = asPostId(item.inReplyToId, item.inReplyToStatusId, item.in_reply_to_status_id_str);
  return {
    id,
    text,
    created_at: createdAt,
    author: {
      handle,
      id: asPostId(item.author?.id) ?? "",
      // null when the actor omits it (treated as unknown downstream, never a
      // follower-floor penalty) — matches the bird path's contract.
      followers: asCount(item.author?.followers),
      bio: asBio(item.author?.description, item.author?.rawDescription, item.author?.bio),
    },
    url: firstString(item.url, item.twitterUrl) ?? `https://x.com/${handle}/status/${id}`,
    // Pure native retweet → dropped by discovery (a reply would land on a
    // stranger's words). Quote-tweets are not reposts and stay false. apidojo
    // set isRetweet; kaito instead populates retweeted_tweet — honour both.
    is_repost: item.isRetweet === true || item.retweeted_tweet != null,
    // Reply (sits under another post) → dropped by discovery when excludeReplies
    // is on, so the agent answers original posts, not buried comments.
    is_reply: asIsReply(item, id),
    ...(conversation ? { conversation_id: conversation } : {}),
    ...(parent ? { in_reply_to_id: parent } : {}),
    ...(images ? { images } : {}),
    likes: asCount(item.likeCount, item.favoriteCount, item.favorite_count, item.likes),
    reposts: asCount(item.retweetCount, item.retweet_count),
    replies: asCount(item.replyCount, item.reply_count),
  };
}

export function createApifyXClient(opts: CreateApifyXClientOpts): ApifyXClient {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const baseUrl = opts.baseUrl ?? DEFAULT_BASE_URL;
  const timeoutMs = opts.timeoutMs ?? 120_000;
  const actorIdDefault = opts.actorId ?? X_SCRAPER_ACTOR_ID;

  const transport = createApifyTransport({
    token: opts.token, baseUrl, timeoutMs, fetchImpl,
    errorFactory: (message, status) => new ApifyXError(message, status),
  });

  async function runActorSync(input: unknown, itemLimit: number, actorOverride?: string): Promise<{ items: ApifyTweetItem[] } & ApifyResultCoverage> {
    const actorId = actorOverride ?? actorIdDefault;
    const actor = actorOverride === X_FOLLOWER_ACTOR_ID ? X_FOLLOWER_ACTOR : X_SCRAPER_ACTOR;
    const result = await transport.runActor({ actorId, actor, input, itemLimit });
    return { ...result, items: result.items as ApifyTweetItem[] };
  }

  function normalizeAll(result: { items: ApifyTweetItem[] } & ApifyResultCoverage, limit: number, sinceISO?: string): ApifyXRunResult {
    const { items, ...coverage } = result;
    const since = sinceISO ? new Date(sinceISO).getTime() : 0;
    const seen = new Set<string>();
    const out: XTweet[] = [];
    for (const item of items) {
      const t = normalizeTweet(item);
      if (!t || seen.has(t.id)) continue;
      // Mirror the bird path: drop tweets at/before the since-window client-side.
      // The `since_time:` operator narrows this server-side too, but it is
      // hour-granular and best-effort — this stays as the exact backstop.
      if (since && new Date(t.created_at).getTime() <= since) continue;
      seen.add(t.id);
      out.push(t);
    }
    return { tweets: out.slice(0, limit), ...coverage };
  }

  /**
   * Normalise one follower-actor record. The actor returns X's own user shape,
   * whose key casing varies by version, so every field is read defensively and
   * an absent value stays null (never "" or 0) — the ICP gate and the follower
   * floor both treat null as UNKNOWN rather than as a bad value.
   */
  function normalizePerson(raw: unknown): XCandidatePerson | null {
    if (!raw || typeof raw !== "object") return null;
    const r = raw as Record<string, unknown>;
    const handleRaw =
      firstString(r.userName, r.username, r.screen_name, r.screenName) ?? "";
    const handle = handleRaw.trim().toLowerCase().replace(/^@/, "");
    if (!handle) return null;
    return {
      handle,
      id: firstString(r.id, r.id_str, r.userId, r.rest_id) ?? null,
      displayName: firstString(r.name, r.displayname, r.displayName) ?? null,
      bio: firstString(r.description, r.bio, r.rawDescription) ?? null,
      followers: asCount(r.followers ?? r.followers_count ?? r.followersCount),
    };
