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
