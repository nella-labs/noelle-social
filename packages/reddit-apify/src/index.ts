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

function asNumber(v: unknown): number | null {
  if (v == null || (typeof v === "string" && !v.trim())) return null;
  const n = typeof v === "string" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) ? n : null;
}

/** Strip a leading "t3_" (Reddit's link/post fullname prefix) from an id. */
function stripT3(id: string): string {
  return id.replace(/^t3_/, "");
}

/** Reddit numeric source timestamps are Unix seconds; unknown remains empty. */
function toISO(...candidates: unknown[]): string {
  for (const value of candidates) {
    const measured = typeof value === "number"
      ? readSourceEpochTimestamp(value, "seconds") : readSourceTimestamp(value);
    if (measured !== null) return measured;
  }
  return "";
}

/** Known signed measurements precede unknown; stable sort retains unknown order. */
function byVoteScore(a: RedditComment, b: RedditComment): number {
  return (b.score ?? -Infinity) - (a.score ?? -Infinity) || 0;
}

/** Build the canonical reddit URL from a permalink (path) or an absolute URL. */
function permalinkToUrl(permalink: string): string {
  const p = permalink.trim();
  if (/^https?:\/\//i.test(p)) return p;
  return `https://www.reddit.com${p.startsWith("/") ? "" : "/"}${p}`;
}

/** A string http(s) URL (trimmed), else null. Accepts a {url} object too. */
function asHttpUrl(v: unknown): string | null {
  const s = typeof v === "string" ? v : (v as { url?: unknown } | null)?.url;
  return typeof s === "string" && /^https?:\/\//i.test(s.trim()) ? s.trim() : null;
}

/** First array among the args, or [] — for coalescing nested-comment field names. */
function firstArray(...vals: unknown[]): unknown[] {
  for (const v of vals) if (Array.isArray(v)) return v;
  return [];
}

/** Whether a URL points at an image or a reddit gallery (to salvage post.url). */
function looksLikeImageOrGallery(u: string): boolean {
  return (
    /\.(?:jpe?g|png|gif|webp|bmp)(?:\?|#|$)/i.test(u) ||
    /(?:^|\/\/)(?:i|preview|g)\.redd\.it\//i.test(u) ||
    /i\.imgur\.com\//i.test(u) ||
    /reddit\.com\/gallery\//i.test(u)
  );
}

/**
 * Pull every post-media image URL off a raw item, coalesced + deduped — mirrors
 * @noelle/linkedin-apify's extractImages. Reads previewImages / galleryData[].url
 * / galleryImages / mediaUrl / thumbnail, and finally the post url itself when it
 * looks like an image or gallery. Pure + FAIL-OPEN: anything malformed (non-array,
 * missing url, non-string, "self"/"default" thumbnails) is silently skipped.
 */
function extractImages(item: ApifyRedditItem): string[] {
  const out: string[] = [];
  const push = (v: unknown) => {
    const u = asHttpUrl(v);
    if (u && !out.includes(u)) out.push(u);
  };
  for (const el of firstArray(item.previewImages)) push(el);
  for (const el of firstArray(item.galleryData)) push(el); // [{ url }]
  for (const el of firstArray(item.galleryImages)) push(el);
  push(item.mediaUrl);
  push(item.thumbnail); // "self"/"default"/"nsfw" fail asHttpUrl → skipped
  const rawUrl = asHttpUrl(item.url ?? item.link);
  if (rawUrl && looksLikeImageOrGallery(rawUrl)) push(rawUrl);
  return out;
}

/** Coalesce a comment author to a bare handle (no u/), from a string or object. */
function commentAuthorHandle(c: ApifyRedditComment): string {
  const strip = (s: string) => s.replace(/^\/?u\//i, "").trim();
  if (typeof c.author === "string") return strip(c.author);
  if (c.author && typeof c.author === "object") {
    const o = c.author as { username?: unknown; name?: unknown };
    if (typeof o.username === "string") return strip(o.username);
    if (typeof o.name === "string") return strip(o.name);
  }
  if (typeof c.authorName === "string") return strip(c.authorName);
  return "";
}

/**
 * Map one raw comment (nested or standalone) into RedditComment; null when there
 * is no body. DEFENSIVELY coalesces every field across the actor's unverified
 * spellings and NEVER throws (fail-open). The `body` stays UNTRUSTED text.
 */
export function normalizeRedditComment(raw: unknown): RedditComment | null {
  if (!raw || typeof raw !== "object") return null;
  const c = raw as ApifyRedditComment;
  const body = (
    (typeof c.body === "string" && c.body) ||
    (typeof c.text === "string" && c.text) ||
    (typeof c.bodyText === "string" && c.bodyText) ||
    ""
  ).trim();
  if (!body) return null;
  const score = readSourceVoteScore(c.score, c.upVotes, c.ups);
  const permalinkRaw = (
    (typeof c.permalink === "string" && c.permalink) ||
    (typeof c.postUrl === "string" && c.postUrl) ||
    (typeof c.url === "string" && c.url) ||
    ""
  ).trim();
  const idRaw = c.id != null ? String(c.id) : c.commentId != null ? String(c.commentId) : "";
  return {
    id: idRaw.replace(/^t1_/, ""),
    body,
    score,
    author: commentAuthorHandle(c),
    permalink: permalinkRaw ? permalinkToUrl(permalinkRaw) : "",
  };
}

/** Bare parent post id (t3_ stripped) a standalone comment item belongs to, or "". */
function commentParentPostId(c: ApifyRedditComment): string {
  const raw =
    (typeof c.link_id === "string" && c.link_id) ||
    (typeof c.linkId === "string" && c.linkId) ||
    (typeof c.postId === "string" && c.postId) ||
    (typeof c.parentPostId === "string" && c.parentPostId) ||
    (typeof c.parentId === "string" && c.parentId) ||
    "";
  return raw.replace(/^t3_/, "");
}

/** True ONLY when an item explicitly declares itself a comment (dataType/type). */
function isStandaloneCommentItem(raw: unknown): boolean {
  if (!raw || typeof raw !== "object") return false;
  const o = raw as { dataType?: unknown; type?: unknown };
  const disc = String(o.dataType ?? o.type ?? "").toLowerCase();
  return disc === "comment" || disc === "t1";
}

/** Bare post id (t3_ stripped) for a raw post item — mirrors normalizeRedditPost. */
function rawPostId(item: ApifyRedditItem): string {
  return String(item.id ?? item.name ?? "").replace(/^t3_/, "");
}

export function normalizeRedditPost(
  raw: unknown,
  opts?: {
    /** Cap on how many top comments to keep (default 8). */
    commentsPerPost?: number;
    /** Standalone comment rows grouped to this post by the client (separate-items mode). */
    extraComments?: unknown[];
  },
): RedditPost | null {
  if (!raw || typeof raw !== "object") return null;
  const item = raw as ApifyRedditItem;
  const rawId = String(item.id ?? item.name ?? "");
  const id = rawId ? stripT3(rawId) : "";
  const title = (item.title ?? "").trim();
  // Need an id + a title or there's nothing to act on.
  if (!id || !title) return null;

  const body = (item.selfText ?? item.selftext ?? item.body ?? item.text ?? "").trim();

  const permalink = item.permalink ?? "";
  const url = permalink ? permalinkToUrl(permalink) : "";

  // On a link post, `url`/`link` points at the external target. On a self post it
  // usually mirrors the permalink, so only surface it when it's a real http(s) URL
  // and not the same as our canonical reddit URL.
  let externalUrl: string | undefined;
  const rawUrl = (item.url ?? item.link ?? "").toString().trim();
  if (/^https?:\/\//i.test(rawUrl) && rawUrl !== url) externalUrl = rawUrl;

  const subredditRaw = (item.subreddit ?? item.subredditName ?? "").toString().trim();
  const subreddit = subredditRaw.replace(/^\/?r\//i, "");

  const createdAt = toISO(item.createdAt, item.created, item.createdUtc, item.created_utc);

  const author =
    typeof item.author === "string"
      ? item.author
      : item.author?.name ?? item.author?.username ?? item.username ?? "";

  const ratio = asNumber(item.upvoteRatio ?? item.upvote_ratio);

  // Media images — coalesced defensively; omit the key when none (never []).
  const images = extractImages(item);

  // Top comments — nested (common case) plus any standalone rows the client
  // grouped to this post. Normalize, drop empties, sort by score desc, slice.
  const commentsPerPost = opts?.commentsPerPost ?? 8;
  const rawComments: unknown[] = [
    ...firstArray(item.comments, item.topComments, item.commentList),
    ...(opts?.extraComments ?? []),
  ];
