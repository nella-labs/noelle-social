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
  }): Promise<CandidateProfile[]>;
}

// One image entry from the actor's postImages array (and the same {url,...}
// shape reused by article.image / postVideo thumbnails). All fields optional.
interface ApifyImage {
  url?: string;
  width?: unknown;
  height?: unknown;
  expiresAt?: unknown;
}

// Apify item shape (subset we read) — fields are best-effort/optional. The media
// fields mirror HarvestAPI's post schema (profile-posts + post-search): postImages
// is an array of {url,...}; postVideo carries a thumbnailUrl; article nests an
// image object; a document carousel exposes coverPages[].imageUrls (string URLs).
// We read all of them defensively and coalesce to LinkedInPost.images.
interface ApifyPostItem {
  id?: string;
  linkedinUrl?: string;
  content?: string;
  author?: {
    name?: string;
    publicIdentifier?: string;
    /** Company pages leave publicIdentifier null but carry the slug here. */
    universalName?: string;
    /** "member" (person) | "company" — the keyword lane skips company pages. */
    type?: string;
    linkedinUrl?: string;
    info?: string;
  };
  postedAt?: { timestamp?: number; date?: string; postedAgoText?: string };
  engagement?: { likes?: unknown; comments?: unknown; shares?: unknown };
  postImages?: ApifyImage[];
  postVideo?: { thumbnailUrl?: string; videoUrl?: string };
  article?: { image?: ApifyImage };
  document?: { coverPages?: Array<{ imageUrls?: unknown }> };
}

// Apify profile item shape (subset we read) from the profile-search actor. All
// fields best-effort/optional; field names vary by mode so we read defensively.
// profile-search "Short" mode shape (verified against a live run): no
// publicIdentifier/headline — instead firstName/lastName, a `summary` (the
// about/bio text), and `currentPositions[].title` (the real role line, e.g.
// "Founder & CEO"). `id` is the member id (urn:li:fsd_profile: stripped) and
// `linkedinUrl` is /in/<that id>. We coalesce a headline from the position
// titles (primary signal) then the summary, so the ICP gate has text to match.
interface ApifyProfileItem {
  id?: string;
  publicIdentifier?: string;
  username?: string;
  linkedinUrl?: string;
  name?: string;
  firstName?: string;
  lastName?: string;
  headline?: string;
  occupation?: string;
  summary?: string;
  currentPositions?: Array<{ title?: string; position?: string; companyName?: string }>;
}

// Apify comment item shape (subset we read) from the post-comments actor.
interface ApifyCommentItem {
  id?: string;
  linkedinUrl?: string;
  commentary?: string;
  createdAt?: string | number;
  numComments?: unknown;
  reactionTypeCounts?: Array<{ type?: string; count?: unknown }>;
  actor?: { name?: string; position?: string; linkedinUrl?: string };
}

// Apify item shape (subset we read) from the profile-comments actor
// (harvestapi/linkedin-profile-comments). DIFFERENT field layout from the
// post-comments actor: counts live under a nested `engagement` object
// (engagement.likes / engagement.comments / engagement.reactions[]) instead of
// the flat numComments + reactionTypeCounts. `actor` is the target profile (the
// author of the comment); `post` is the parent post the comment was left on. All
// fields best-effort/optional — read defensively.
interface ApifyAuthoredCommentItem {
  id?: string;
  linkedinUrl?: string;
  commentary?: string;
  createdAt?: string | number;
  createdAtTimestamp?: number;
  engagement?: {
    likes?: unknown;
    comments?: unknown;
    reactions?: Array<{ type?: string; count?: unknown }>;
  };
  actor?: { name?: string; position?: string; linkedinUrl?: string };
  post?: unknown;
}

function reactionTotal(counts: Array<{ count?: unknown }> | undefined): number | null {
  if (!Array.isArray(counts)) return null;
  let total = 0;
  for (const item of counts) {
    const count = readSourceCount(item?.count);
    if (count === null || !Number.isSafeInteger(total + count)) return null;
    total += count;
  }
  return total;
}

function publicIdToUrl(publicId: string): string {
  return `https://www.linkedin.com/in/${publicId.replace(/^@/, "").trim()}`;
}

/**
 * Map a valid ISO lower bound to the configured coarse `postedLimit` hints
 * ("24h" | "week" | "month"). Precise filtering still happens client-side.
 * Bounds older than 31 days omit the hint. Unset/invalid dates omit it too.
 */
function sinceToPostedLimit(sinceISO?: string): "24h" | "week" | "month" | undefined {
  const timestamp = readSourceTimestamp(sinceISO);
  if (timestamp === null) return undefined;
  const since = Date.parse(timestamp);
  const ageMs = Date.now() - since;
  if (ageMs <= 0) return "24h";
  const DAY = 86_400_000;
  if (ageMs <= DAY) return "24h";
  if (ageMs <= 7 * DAY) return "week";
  if (ageMs <= 31 * DAY) return "month";
  return undefined;
}

function asHttpUrl(v: unknown): string | null {
  return typeof v === "string" && /^https?:\/\//i.test(v.trim()) ? v.trim() : null;
}

/**
 * Pull every post-media image URL off the raw actor item, coalesced + deduped.
 * Reads the several HarvestAPI media fields (postImages, the postVideo thumbnail,
 * an article preview image, a document carousel's coverPages[].imageUrls). Pure
 * and fail-open: anything malformed (non-array, missing url, non-string) is
 * silently skipped, so a downstream vision step gets only real http(s) URLs.
 */
function extractImages(item: ApifyPostItem): string[] {
  const out: string[] = [];
  const push = (v: unknown) => {
    const u = asHttpUrl(v);
    if (u && !out.includes(u)) out.push(u);
  };
  if (Array.isArray(item.postImages)) for (const img of item.postImages) push(img?.url);
  push(item.postVideo?.thumbnailUrl);
  push(item.article?.image?.url);
  if (Array.isArray(item.document?.coverPages)) {
    for (const page of item.document!.coverPages) {
      if (Array.isArray(page?.imageUrls)) for (const u of page.imageUrls) push(u);
    }
  }
  return out;
}

export function normalizePost(item: ApifyPostItem): LinkedInPost | null {
  const rawId = String(item.id ?? "");
  const text = (item.content ?? "").trim();
  const digits = rawId.match(/(\d{6,})/);
  const id = digits ? digits[1]! : rawId;
  if (!id || !text) return null;
  const postedAt = readSourceEpochTimestamp(item.postedAt?.timestamp, "milliseconds")
    ?? readSourceTimestamp(item.postedAt?.date);
  const eng = item.engagement ?? {};
  const a = item.author ?? {};
  const images = extractImages(item);
  return {
    id,
    urn: rawId.startsWith("urn:") ? rawId : `urn:li:activity:${id}`,
    text,
    url: item.linkedinUrl ?? "",
    postedAt,
    reactions: readSourceCount(eng.likes),
    comments: readSourceCount(eng.comments),
    // Omit the key on a text-only post; never emit an empty array.
    ...(images.length > 0 ? { images } : {}),
    author: {
      name: a.name ?? null,
      // Person posts populate publicIdentifier; company pages leave it null but
      // carry the slug in universalName (confirmed against a live post-search run).
      // publicIdentifier is sometimes an opaque member URN (ACwAA…) — recover the
      // real vanity slug from the author/post URL so the person stays profilable.
      publicId: resolveVanitySlug({
        publicId: a.publicIdentifier ?? a.universalName ?? null,
        profileUrl: a.linkedinUrl ?? null,
        postUrl: item.linkedinUrl ?? null,
      }),
      url: a.linkedinUrl ?? null,
      headline: a.info ?? null,
      type: a.type ?? null,
    },
  };
}

/** Slug out of a linkedin.com/in/<slug> URL, or null. */
function slugFromUrl(url: string | undefined): string | null {
  if (typeof url !== "string") return null;
  const m = url.match(/linkedin\.com\/in\/([^/?#]+)/i);
  return m ? decodeURIComponent(m[1]!) : null;
}

/**
 * True when `id` is an opaque LinkedIn member URN id (`ACwAA…`, `ACoAA…`) rather
 * than a human vanity slug. The actor sometimes returns one of these in
 * `publicIdentifier` for members with a restricted/absent vanity URL. Such an id
 * is NOT usable as `linkedin.com/in/<slug>` for the posts actor, so the profiler
 * would back off with "no public_id" forever — see `resolveVanitySlug`.
 */
export function isMemberUrnId(id: string | null | undefined): boolean {
  // Case-INSENSITIVE: these ids reach us lowercased through some paths (two such
  // rows sit in linkedin_watchlist_people today, both stuck unprofiled), and a
  // case-sensitive test would leave exactly the people this is meant to rescue.
  //
  // The length floor is what keeps real slugs out. Every member id observed is
  // exactly 39 chars; ordinary vanity slugs are far shorter, and a real one like
  // `achim-bonsch-a9186a38` (21) would be misread as a urn under a {20,} rule.
  // 30+ is comfortably above every real slug and tolerates id-length drift.
  return typeof id === "string" && /^ac[a-z0-9_-]{28,}$/i.test(id.trim());
}

/** Vanity slug out of a post permalink (linkedin.com/posts/<slug>_…), or null. */
export function slugFromPostUrl(url: string | null | undefined): string | null {
  if (typeof url !== "string") return null;
  // Vanity slugs are [a-z0-9-] — the first `_` always ends the slug and starts
  // the post's text fragment. `/feed/update/urn:…` permalinks carry no slug.
  const m = url.match(/linkedin\.com\/posts\/([^_/?#]+)_/i);
  return m ? decodeURIComponent(m[1]!) : null;
}

/**
 * Best available `linkedin.com/in/<slug>` key for a person, preferring a real
 * vanity slug over an opaque member URN id. Order: a non-URN publicId, the
 * profile URL's slug, the post permalink's slug, then the URN as a last resort
 * (better than null — some URN ids still resolve).
 *
 * Why this exists: profiling is keyed on the slug (`profilePosts({publicId})`),
 * so a person whose `publicIdentifier` came back as a URN was unprofilable even
 * though their own post URL spells the slug out.
 */
export function resolveVanitySlug(args: {
  publicId?: string | null;
  profileUrl?: string | null;
  postUrl?: string | null;
}): string | null {
  const pid = args.publicId?.trim() || null;
  if (pid && !isMemberUrnId(pid)) return pid;
  const fromProfile = slugFromUrl(args.profileUrl ?? undefined);
  if (fromProfile && !isMemberUrnId(fromProfile)) return fromProfile;
  const fromPost = slugFromPostUrl(args.postUrl);
  if (fromPost && !isMemberUrnId(fromPost)) return fromPost;
  return pid;
}

/** Strip the urn:li:fsd_profile: prefix when the actor returns a full urn. */
function stripFsdPrefix(id: string | undefined): string | null {
  if (typeof id !== "string" || !id) return null;
  return id.replace(/^urn:li:fsd_profile:/, "");
}

export function normalizeProfile(item: ApifyProfileItem): CandidateProfile | null {
  const publicId =
    item.publicIdentifier ?? item.username ?? slugFromUrl(item.linkedinUrl) ?? null;
  const name = (item.name ?? [item.firstName, item.lastName].filter(Boolean).join(" ")).trim();
  // Headline for the ICP gate: prefer the current-role titles (the precise
  // signal), then any explicit headline/occupation, then the summary/bio. Short
  // mode returns none of headline/occupation, so currentPositions/summary carry it.
  const positionsText = Array.isArray(item.currentPositions)
    ? item.currentPositions
        .map((p) => p?.title ?? p?.position ?? p?.companyName)
        .filter((s): s is string => typeof s === "string" && s.trim().length > 0)
        .join(" · ")
    : "";
  const headline =
    [positionsText, item.headline, item.occupation, item.summary]
      .map((s) => (typeof s === "string" ? s.trim() : ""))
      .find((s) => s.length > 0) ?? null;
  // Need at least a way to address the person (slug) — otherwise we can't fetch
  // their posts, so the candidate is useless.
  if (!publicId) return null;
  return {
    publicId,
    name: name.length > 0 ? name : null,
    headline,
    url: item.linkedinUrl ?? null,
    fsdProfileId: stripFsdPrefix(item.id),
  };
}

export function normalizeComment(item: ApifyCommentItem): LinkedInComment | null {
  const text = (item.commentary ?? "").trim();
  if (!text) return null;
  const reactions = reactionTotal(item.reactionTypeCounts);
  const createdAt = readSourceTimestamp(item.createdAt)
    ?? readSourceEpochTimestamp(item.createdAt, "milliseconds");
  return {
    id: String(item.id ?? item.linkedinUrl ?? text.slice(0, 32)),
    url: item.linkedinUrl ?? "",
    text,
    authorName: item.actor?.name ?? null,
    authorHeadline: item.actor?.position ?? null,
    reactions,
    repliesCount: readSourceCount(item.numComments),
    createdAt,
  };
}

/**
 * Map one profile-comments actor item (a comment the profile AUTHORED) into the
 * shared LinkedInComment shape. Sibling to normalizeComment but for the
 * different profile-comments layout: reactions = sum of engagement.reactions[]
 * counts (falling back to engagement.likes when the breakdown is absent),
 * repliesCount = engagement.comments, timestamp from createdAt (ISO) or
 * createdAtTimestamp (unix ms). authorName/headline are the target profile
 * (item.actor) — i.e. WHO wrote the comment, which is exactly the voice we want.
 * Returns null for an empty body (same contract as normalizeComment).
 */
export function normalizeAuthoredComment(item: ApifyAuthoredCommentItem): LinkedInComment | null {
  const text = (item.commentary ?? "").trim();
  if (!text) return null;
  const eng = item.engagement ?? {};
  // Prefer the per-type reaction breakdown; fall back to the flat like count.
  const reactions: number | null = Array.isArray(eng.reactions)
    ? reactionTotal(eng.reactions)
    : readSourceCount(eng.likes);
  const createdAt = readSourceTimestamp(item.createdAt)
    ?? readSourceEpochTimestamp(item.createdAt, "milliseconds")
    ?? readSourceEpochTimestamp(item.createdAtTimestamp, "milliseconds");
  return {
    id: String(item.id ?? item.linkedinUrl ?? text.slice(0, 32)),
    url: item.linkedinUrl ?? "",
    text,
    authorName: item.actor?.name ?? null,
    authorHeadline: item.actor?.position ?? null,
    reactions,
    repliesCount: readSourceCount(eng.comments),
    createdAt,
  };
}

export function createApifyLinkedInClient(opts: CreateApifyLinkedInClientOpts): ApifyLinkedInClient {
  const transport = createApifyTransport({
    token: opts.token,
    ...(opts.baseUrl ? { baseUrl: opts.baseUrl } : {}),
    ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
    ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
    errorFactory: (message, status) => new ApifyError(message, status),
  });
  const profilePostsActorId = opts.profilePostsActorId ?? PROFILE_POSTS_ACTOR_ID;
  const postSearchActorId = opts.postSearchActorId ?? POST_SEARCH_ACTOR_ID;
  const postCommentsActorId = opts.postCommentsActorId ?? POST_COMMENTS_ACTOR_ID;
  const profileSearchActorId = opts.profileSearchActorId ?? PROFILE_SEARCH_ACTOR_ID;
  const profileCommentsActorId = opts.profileCommentsActorId ?? PROFILE_COMMENTS_ACTOR_ID;

  async function runActorSync<T = ApifyPostItem>(actorId: string, actor: string, input: unknown, itemLimit: number): Promise<T[]> {
    const result = await transport.runActor({ actorId, actor, input, itemLimit });
    return result.items as T[];
  }

  function normalizeAll(items: ApifyPostItem[], maxPosts: number, sinceISO?: string): LinkedInPost[] {
    const since = readSourceTimestamp(sinceISO);
    const seen = new Set<string>();
    const out: LinkedInPost[] = [];
    for (const item of items) {
      const p = normalizePost(item);
      if (!p || seen.has(p.id)) continue;
      if (since !== null && p.postedAt !== null && p.postedAt <= since) continue;
      seen.add(p.id);
      out.push(p);
    }
    return out.slice(0, maxPosts);
  }

  return {
    drainLastRunUsd: transport.drainLastRunUsd,
    drainRunReceipts: transport.drainRunReceipts,
    async profilePosts({ profileUrl, publicId, maxPosts = 5, sinceISO, includeReposts = false }) {
      transport.beginOperation();
      const target = profileUrl ?? (publicId ? publicIdToUrl(publicId) : undefined);
      if (!target) throw new ApifyError("profilePosts requires profileUrl or publicId", 0);
      const since = readSourceTimestamp(sinceISO);
      const items = await runActorSync(profilePostsActorId, "linkedin-profile-posts", {
        targetUrls: [target],
        maxPosts,
        includeReposts,
        ...(since ? { postedLimitDate: since } : {}),
      }, maxPosts);
      return normalizeAll(items, maxPosts, sinceISO);
    },

    async searchPosts({ queries, authorsPublicIdentifiers, maxPosts = 10, postedLimit, sinceISO }) {
      transport.beginOperation();
      assertApifyItemLimit(maxPosts * queries.length, (message, status) => new ApifyError(message, status));
      const items = await runActorSync(postSearchActorId, "linkedin-post-search", {
        searchQueries: queries,
        ...(authorsPublicIdentifiers ? { authorsPublicIdentifiers } : {}),
        maxPosts,
        sortBy: "date",
        ...(postedLimit ? { postedLimit } : {}),
      }, maxPosts);
      return normalizeAll(items, maxPosts, sinceISO);
    },

    async searchProfiles({
      searchQuery,
      currentJobTitles,
      locations,
      seniorityLevelIds,
      yearsOfExperienceIds,
      industryIds,
      schools,
      maxItems = 25,
      mode = "Short",
    }) {
      transport.beginOperation();
      const items = await runActorSync<ApifyProfileItem>(profileSearchActorId, "linkedin-profile-search", {
        ...(searchQuery ? { searchQuery } : {}),
        ...(currentJobTitles && currentJobTitles.length ? { currentJobTitles } : {}),
        ...(locations && locations.length ? { locations } : {}),
        ...(seniorityLevelIds && seniorityLevelIds.length ? { seniorityLevelIds } : {}),
        ...(yearsOfExperienceIds && yearsOfExperienceIds.length ? { yearsOfExperienceIds } : {}),
        ...(industryIds && industryIds.length ? { industryIds } : {}),
        ...(schools && schools.length ? { schools } : {}),
        maxItems,
        profileScraperMode: mode,
      }, maxItems);
      const seen = new Set<string>();
      const out: CandidateProfile[] = [];
      for (const item of items) {
        const p = normalizeProfile(item);
        if (!p || !p.publicId || seen.has(p.publicId)) continue;
        seen.add(p.publicId);
        out.push(p);
      }
      return out.slice(0, maxItems);
    },

    async postComments({ postUrl, maxComments = 40 }) {
      transport.beginOperation();
      if (!postUrl) throw new ApifyError("postComments requires postUrl", 0);
      const items = await runActorSync<ApifyCommentItem>(postCommentsActorId, "linkedin-post-comments", {
        postUrls: [postUrl],
        maxItems: maxComments,
      }, maxComments);
      const seen = new Set<string>();
      const out: LinkedInComment[] = [];
      for (const item of items) {
        const c = normalizeComment(item);
        if (!c || seen.has(c.id)) continue;
        seen.add(c.id);
        out.push(c);
      }
      return out.slice(0, maxComments);
    },

    async authoredComments({ profileUrl, publicId, maxComments = 40, sinceISO }) {
      transport.beginOperation();
      const target = profileUrl ?? (publicId ? publicIdToUrl(publicId) : undefined);
      if (!target) throw new ApifyError("authoredComments requires profileUrl or publicId", 0);
      const postedLimit = sinceToPostedLimit(sinceISO);
      const items = await runActorSync<ApifyAuthoredCommentItem>(profileCommentsActorId, "linkedin-profile-comments", {
        // The actor targets by full profile URL (no publicIdentifier/targetUrls key).
        profiles: [target],
        maxItems: maxComments,
        ...(postedLimit ? { postedLimit } : {}),
      }, maxComments);
      const since = readSourceTimestamp(sinceISO);
      const seen = new Set<string>();
      const out: LinkedInComment[] = [];
      for (const item of items) {
        const c = normalizeAuthoredComment(item);
        if (!c || seen.has(c.id)) continue;
        // Precise recency floor (the actor's postedLimit is only coarse). Keep
        // items with no timestamp — dropping them would silently lose data.
        if (since !== null && c.createdAt !== null && c.createdAt <= since) continue;
        seen.add(c.id);
        out.push(c);
      }
      return out.slice(0, maxComments);
    },
  };
}
