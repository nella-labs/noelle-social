// LinkedIn posts transport via Apify (HarvestAPI actors).
//
// Why: raw Voyager works for identity but the posts feed is fingerprint-blocked
// for non-browser clients (302), and sessions die in minutes. Apify's HarvestAPI
// actors run their own proxies + maintained scrapers and need NO LinkedIn cookies
// or login — so there's no li_at, no JSESSIONID, no fingerprint, no session death.
// We just POST a profile URL + token and get the person's posts back.
//
// Read-only by design: this only FETCHES posts. The intern (Lyra) drafts for
// human approval and never posts to LinkedIn.
//
// Actors (HarvestAPI):
//   - profile-posts (A3cAPGpwBEG8RJwse): every post from a profile URL. The exact
//     fit for "react to every post from a watchlist person" (no keyword needed).
//   - post-search   (buIWk2uOUzTmcLsuB): keyword search; can filter by author +
//     postedLimit. Available for future keyword-based discovery.
//   - post-comments (harvestapi~linkedin-post-comments, $2/1k comments): the
//     existing comments ON a post (text + commenter + reactions), so the drafter
//     can read the room and avoid echoing what the crowd already said.
//   - profile-comments (harvestapi~linkedin-profile-comments, $2/1k comments): the
//     comments a PROFILE AUTHORED on OTHER people's posts (their real outbound
//     reply voice). Distinct from post-comments (comments ON a post). Powers the
//     Account Feeder's authored-comments corpus.

import { assertApifyItemLimit, createApifyTransport } from "@noelle/runtime/apify-transport";
import type { ApifyRunReceipt } from "@noelle/runtime/apify-run-receipts";
import { readSourceCount, readSourceEpochTimestamp, readSourceTimestamp } from "@noelle/runtime/source-values";

export const PROFILE_POSTS_ACTOR_ID = "A3cAPGpwBEG8RJwse"; // harvestapi/linkedin-profile-posts
export const POST_SEARCH_ACTOR_ID = "buIWk2uOUzTmcLsuB"; // harvestapi/linkedin-post-search
// Addressed by its username~name slug (the run-sync endpoint accepts that form),
// so there's no opaque hash to track.
export const POST_COMMENTS_ACTOR_ID = "harvestapi~linkedin-post-comments";
// profile-search (harvestapi/linkedin-profile-search): find PEOPLE by ICP filters
// (searchQuery + currentJobTitles + locations + seniority/experience/industry +
// schools). Drives profile-first discovery's Feeder A. Slug form (run-sync accepts it).
export const PROFILE_SEARCH_ACTOR_ID = "harvestapi~linkedin-profile-search";
// profile-comments (harvestapi/linkedin-profile-comments, tech id FiHYLewnJwS6GnRpo,
// $2/1k comments): the comments a profile AUTHORED on other posts — their reply
// voice. VERIFIED 2026-06-19 against the public, token-free Apify metadata API
// (GET /v2/acts/harvestapi~linkedin-profile-comments → username:harvestapi,
// name:linkedin-profile-comments, build 0.0.18). Input is
// { profiles:[<full profile URL>], maxItems, postedLimit:"24h"|"week"|"month" } —
// it targets by full profile URL (NO publicIdentifier/username/targetUrls key).
// Slug form (run-sync accepts it).
export const PROFILE_COMMENTS_ACTOR_ID = "harvestapi~linkedin-profile-comments";

/**
 * Whether a real source for a profile's AUTHORED comments is wired (vs. the
 * spec §6.1 fallback to comments-on-their-own-posts). TRUE here: the verified
 * harvestapi/linkedin-profile-comments actor backs `authoredComments`. F5/F6 read
 * this to decide how to degrade if it were ever flipped off.
 */
export const AUTHORED_COMMENTS_SUPPORTED = true;

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

export interface LinkedInPostAuthor {
  name: string | null;
  publicId: string | null;
  url: string | null;
  headline: string | null;
  /** "member" (person) vs "company"; best-effort. Keyword lane skips companies. */
  type?: string | null;
}

export interface LinkedInPost {
  /** Numeric activity/share id (digits from the URN), used as leads.external_id. */
  id: string;
  urn: string;
  text: string;
  url: string;
  /** Canonical ISO 8601 from a valid source timestamp, or null when unknown. */
  postedAt: string | null;
  reactions: number | null;
  comments: number | null;
  /**
   * Post media image URLs (photos, the video thumbnail, an article preview, a
   * doc carousel's page images), coalesced from the actor's several media fields.
   * Absent on a text-only post (the field is omitted, never an empty array), so a
   * downstream vision-caption step can `if (post.images)` and skip the LLM call.
   */
  images?: string[];
  author: LinkedInPostAuthor;
}

/**
 * A candidate person from the profile-search actor (Feeder A). Enough to gate on
 * the ICP (headline) and then fetch their posts (publicId → profilePosts).
 */
export interface CandidateProfile {
  /** Vanity slug (linkedin.com/in/<publicId>); the key for profilePosts. */
  publicId: string | null;
  name: string | null;
  headline: string | null;
  url: string | null;
  /** urn:li:fsd_profile:<id> stripped, when the actor returns it (often absent in short mode). */
  fsdProfileId: string | null;
}

/** One existing comment on a post (from the post-comments actor). */
export interface LinkedInComment {
  /** Comment id (or its URL / a text prefix when the actor omits one). */
  id: string;
  url: string;
  text: string;
  authorName: string | null;
  /** The commenter's title/headline ("position"), when enriched. */
  authorHeadline: string | null;
  /** Total reactions on the comment (sum of reactionTypeCounts), or null. */
  reactions: number | null;
  /** Reply count on the comment, or null. */
  repliesCount: number | null;
  /** Canonical ISO 8601 when known, else null. */
  createdAt: string | null;
}

export interface CreateApifyLinkedInClientOpts {
  /** Apify API token. The only credential — no LinkedIn cookies. */
  token: string;
  /** Override the profile-posts actor id (default harvestapi/linkedin-profile-posts). */
  profilePostsActorId?: string;
  /** Override the post-search actor id (default harvestapi/linkedin-post-search). */
  postSearchActorId?: string;
  /** Override the post-comments actor id (default harvestapi~linkedin-post-comments). */
  postCommentsActorId?: string;
  /** Override the profile-search actor id (default harvestapi~linkedin-profile-search). */
  profileSearchActorId?: string;
  /** Override the profile-comments actor id (default harvestapi~linkedin-profile-comments). */
  profileCommentsActorId?: string;
  /** Apify API base (default https://api.apify.com). */
  baseUrl?: string;
  /** Max wait for a synchronous actor run (ms). Default 120000. */
  timeoutMs?: number;
  /** Injectable fetch for tests. */
  fetchImpl?: typeof fetch;
}

export interface ApifyLinkedInClient {
  /** Independent logical-operation state, provided by rotating client facades. */
  isolateOperation?(): ApifyLinkedInClient;
  /** Every post from a profile (URL or public slug like "kaia-tham"). */
  profilePosts(args: {
    profileUrl?: string;
    publicId?: string;
    maxPosts?: number;
    sinceISO?: string;
    includeReposts?: boolean;
  }): Promise<LinkedInPost[]>;
  /** Keyword post search, optionally scoped to author public identifiers. */
  searchPosts(args: {
    queries: string[];
    authorsPublicIdentifiers?: string[];
    maxPosts?: number;
    /** Coarse recency hint passed to the actor (e.g. "week", "month"). */
    postedLimit?: string;
    /** Precise client-side lower bound: drop posts at/older than this ISO time. */
    sinceISO?: string;
  }): Promise<LinkedInPost[]>;
  /** The existing comments on a single post (most-engaged first as the actor returns them). */
  postComments(args: { postUrl: string; maxComments?: number }): Promise<LinkedInComment[]>;
  /**
   * The comments a PROFILE AUTHORED on other people's posts (their outbound reply
   * voice) — distinct from postComments (comments ON a post). Backed by the
   * verified harvestapi/linkedin-profile-comments actor. Target by `profileUrl`
   * or `publicId`. `sinceISO` is mapped to the actor's coarse `postedLimit`
   * bucket (24h/week/month) AND enforced precisely client-side.
   */
  authoredComments(args: {
    profileUrl?: string;
    publicId?: string;
    maxComments?: number;
    sinceISO?: string;
  }): Promise<LinkedInComment[]>;
  /** Final reported charges for the current operation, including failed runs. */
  drainRunReceipts?(): ApifyRunReceipt[];
  /** Legacy single drain; null when any run's actual charge is unknown. */
  drainLastRunUsd?(): number | null;
  /** Find people by ICP filters (profile-first discovery, Feeder A). Short mode by default. */
  searchProfiles(args: {
    searchQuery?: string;
    currentJobTitles?: string[];
    locations?: string[];
    seniorityLevelIds?: string[];
    yearsOfExperienceIds?: string[];
    industryIds?: string[];
    schools?: string[];
    maxItems?: number;
    /** "Short" (cheap, basic data) | "Full" (opens each profile). Default "Short". */
    mode?: "Short" | "Full";
