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
    ? Math.trunc(value) : null;
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/** The single gate: only an enabled x_intern may obtain a writable client. */
export function assertXWriteAllowed(o: { role: string; sendEnabled: boolean; xApiWriteEnabled: boolean }): void {
  if (o.role !== "x_intern" || !o.sendEnabled || !o.xApiWriteEnabled) {
    throw new XWriteForbiddenError(
      `x write refused: role=${o.role} send_enabled=${o.sendEnabled} x_api_write_enabled=${o.xApiWriteEnabled}`,
    );
  }
}

interface FetchResp {
  status: number;
  ok: boolean;
  headers: { get(k: string): string | null };
  json(): Promise<unknown>;
  text(): Promise<string>;
}

function extractDetail(body: unknown): string {
  if (!body || typeof body !== "object") return "";
  const b = body as { detail?: unknown; title?: unknown; errors?: unknown };
  const parts: string[] = [];
  if (typeof b.detail === "string") parts.push(b.detail);
  if (typeof b.title === "string") parts.push(b.title);
  if (Array.isArray(b.errors)) {
    for (const e of b.errors) {
      const m = e && typeof e === "object" ? (e as { message?: unknown }).message : undefined;
      if (typeof m === "string") parts.push(m);
    }
  }
  return parts.join(" — ");
}

function retryAfterMs(headers: { get(k: string): string | null }): number | undefined {
  const reset = headers.get("x-rate-limit-reset");
  if (reset && /^\d+$/.test(reset)) {
    const ms = Number(reset) * 1000 - Date.now();
    if (ms > 0) return ms;
  }
  const ra = headers.get("retry-after");
  if (ra && /^\d+$/.test(ra)) return Number(ra) * 1000;
  return undefined;
}

function classifyApiError(status: number, body: unknown, headers: { get(k: string): string | null }): never {
  const detail = extractDetail(body);
  if (status === 429) {
    const e = new XRateLimitError(`x api 429 ${detail}`.trim());
    const ms = retryAfterMs(headers);
    if (ms !== undefined) e.retryAfterMs = ms;
    throw e;
  }
  if (status === 403) {
    if (/duplicate content/i.test(detail)) throw new XDuplicateError(`x api ${detail}`);
    if (/suspend|locked|automated|not permitted to perform/i.test(detail)) throw new XLockError(`x api ${detail}`);
    if (
      /reply to this conversation is not allowed|not been mentioned or otherwise engaged|not permitted to reply|who can reply|cannot reply/i.test(
        detail,
      )
    ) {
      throw new XReplyRestrictedError(`x api ${detail}`);
    }
    throw new XError(`x api 403 ${detail}`.trim(), 403);
  }
  if (status === 401) throw new XAuthError(`x api 401 ${detail}`.trim());
  throw new XError(`x api ${status} ${detail}`.trim(), status);
}

function pctEncode(s: string): string {
  return encodeURIComponent(s).replace(/[!*'()]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

/**
 * OAuth 1.0a (HMAC-SHA1) Authorization header. For a JSON POST /2/tweets there
 * are no request parameters to sign; for a GET /2/tweets?ids=… the query params
 * MUST be folded into the signature base string (pass them as `fixed.query` —
 * the RAW, un-encoded values; they are percent-encoded here, matching what
 * URLSearchParams sends on the wire). Query params stay in the URL, never in the
 * returned header.
 */
export function oauth1aHeader(
  method: string,
  url: string,
  creds: OAuth1aCreds,
  fixed?: { nonce?: string; timestamp?: string; query?: Record<string, string> },
): string {
  const oauth: Record<string, string> = {
    oauth_consumer_key: creds.consumerKey,
    oauth_nonce: fixed?.nonce ?? randomBytes(16).toString("hex"),
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: fixed?.timestamp ?? Math.floor(Date.now() / 1000).toString(),
    oauth_token: creds.accessToken,
    oauth_version: "1.0",
  };
  // The signature base covers ALL request params: oauth_* plus any query params.
  const allParams: Record<string, string> = { ...oauth, ...(fixed?.query ?? {}) };
  const paramStr = Object.keys(allParams)
    .sort()
    .map((k) => `${pctEncode(k)}=${pctEncode(allParams[k]!)}`)
    .join("&");
  const base = [method.toUpperCase(), pctEncode(url), pctEncode(paramStr)].join("&");
  const signingKey = `${pctEncode(creds.consumerSecret)}&${pctEncode(creds.accessTokenSecret)}`;
  const signature = createHmac("sha1", signingKey).update(base).digest("base64");
  const header: Record<string, string> = { ...oauth, oauth_signature: signature };
  return "OAuth " + Object.keys(header).sort().map((k) => `${pctEncode(k)}="${pctEncode(header[k]!)}"`).join(", ");
}

export function createXApiClient(opts: XApiClientOpts): XWriteClient {
  assertXWriteAllowed(opts);
  const rawFetch = opts.fetchFn ?? fetch;
  const requestTimeoutMs = Number.isFinite(opts.requestTimeoutMs) && opts.requestTimeoutMs! > 0
    ? Math.min(120_000, Math.ceil(opts.requestTimeoutMs!)) : 20_000;
  const doFetch: typeof fetch = (input, init) => rawFetch(input, {
    ...init, signal: AbortSignal.timeout(requestTimeoutMs),
  });
  let tokens: XApiTokens = { ...(opts.tokens ?? { accessToken: "" }) };
  const handle = opts.handle ?? null;

  // The raw HTTP refresh-token grant, factored out so a coordinator can drive it
  // under an advisory lock. Takes the refresh token as a param (so the caller can
  // pass the CURRENT persisted token, not a stale in-memory one) and RETURNS the
  // rotated tokens — throwing XAuthError on failure rather than returning false.
  async function performHttpRefresh(refreshToken: string): Promise<XApiTokens> {
    const params = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: opts.clientId ?? "",
    });
    const headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded" };
    if (opts.clientSecret) {
      headers.authorization = `Basic ${Buffer.from(`${opts.clientId}:${opts.clientSecret}`).toString("base64")}`;
    }
    const res = (await doFetch(X_OAUTH_TOKEN_URL, {
      method: "POST",
      headers,
      body: params.toString(),
    } as RequestInit)) as unknown as FetchResp;
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new XAuthError(`x oauth2 refresh failed ${res.status} ${extractDetail(body)}`.trim());
    }
    const j = (await res.json()) as { access_token?: string; refresh_token?: string; expires_in?: number };
    if (!j.access_token) throw new XAuthError("x oauth2 refresh: response missing access_token");
    const next: XApiTokens = {
      accessToken: j.access_token,
      // X may omit refresh_token on a refresh; keep the one we refreshed WITH.
      refreshToken: j.refresh_token ?? refreshToken,
    };
    if (j.expires_in) next.expiresAt = Date.now() + j.expires_in * 1000;
    return next;
  }

  // Refresh the access token. With a `refreshCoordinator`, refresh is serialized
  // + persisted across processes (it re-reads the current DB token, calls X once
  // under a lock, and writes the rotation itself — so we do NOT also invoke
  // onTokensRefreshed). Without one, we keep the original inline behavior. Either
  // way, returns false (never throws) on failure so the reactive 401 path can
  // surface a clean XAuthError.
  async function refresh(): Promise<boolean> {
    if (!tokens.refreshToken || !opts.clientId) return false;
    if (opts.refreshCoordinator) {
      try {
        tokens = await opts.refreshCoordinator(performHttpRefresh);
        return true;
      } catch {
        return false;
      }
    }
    try {
      tokens = await performHttpRefresh(tokens.refreshToken);
      await opts.onTokensRefreshed?.(tokens);
      return true;
    } catch {
      return false;
    }
  }

  const tweetUrl = `${X_API_BASE}/tweets`;
  async function tweetRequest(payload: object): Promise<FetchResp> {
    const authorization = opts.oauth1a
      ? oauth1aHeader("POST", tweetUrl, opts.oauth1a)
      : `Bearer ${tokens.accessToken}`;
    return (await doFetch(tweetUrl, {
      method: "POST",
      headers: { authorization, "content-type": "application/json" },
      body: JSON.stringify(payload),
    } as RequestInit).catch(() => {
      throw new XWriteUncertainError("x post response lost; check X before retrying");
    })) as unknown as FetchResp;
  }

  async function metricsRequest(ids: string[]): Promise<FetchResp> {
    // RAW (un-encoded) query values — URLSearchParams and the OAuth base string
    // both percent-encode them, so the two encodings match on the wire.
    const query: Record<string, string> = { ids: ids.join(","), "tweet.fields": "public_metrics" };
    const url = `${tweetUrl}?${new URLSearchParams(query).toString()}`;
    const authorization = opts.oauth1a
      ? oauth1aHeader("GET", tweetUrl, opts.oauth1a, { query })
      : `Bearer ${tokens.accessToken}`;
    return (await doFetch(url, { method: "GET", headers: { authorization } } as RequestInit)) as unknown as FetchResp;
  }
  async function meRequest(): Promise<FetchResp> {
    // Same RAW-query discipline as metricsRequest: the OAuth 1.0a base string and
    // URLSearchParams must percent-encode the same un-encoded values.
    const meUrl = `${X_API_BASE}/users/me`;
    const query: Record<string, string> = { "user.fields": "public_metrics,username,name" };
    const url = `${meUrl}?${new URLSearchParams(query).toString()}`;
    const authorization = opts.oauth1a
      ? oauth1aHeader("GET", meUrl, opts.oauth1a, { query })
      : `Bearer ${tokens.accessToken}`;
    return (await doFetch(url, { method: "GET", headers: { authorization } } as RequestInit)) as unknown as FetchResp;
  }
  // Multipart upload. OAuth 1.0a signs ONLY the oauth_* params for a
  // multipart/form-data body (form fields are excluded from the base string —
  // exactly what oauth1aHeader already does), and fetch sets the multipart
  // Content-Type + boundary from the FormData, so we must NOT set it by hand.
  function buildMediaForm(bytes: Uint8Array, mimeType: string): FormData {
    const form = new FormData();
    // Copy into a fresh ArrayBuffer so the Blob part is a plain ArrayBuffer
    // (not the ArrayBufferLike/SharedArrayBuffer union) and any byte-offset view
    // is normalised.
    const ab = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(ab).set(bytes);
    form.append("media", new Blob([ab], { type: mimeType || "application/octet-stream" }));
    return form;
  }
  async function uploadRequest(bytes: Uint8Array, mimeType: string): Promise<FetchResp> {
    const authorization = opts.oauth1a
      ? oauth1aHeader("POST", X_MEDIA_UPLOAD_URL, opts.oauth1a)
      : `Bearer ${tokens.accessToken}`;
    return (await doFetch(X_MEDIA_UPLOAD_URL, {
      method: "POST",
      headers: { authorization },
      body: buildMediaForm(bytes, mimeType),
    } as unknown as RequestInit)) as unknown as FetchResp;
  }

  return {
    handle,
    async uploadMedia({ bytes, mimeType }) {
      if (!bytes || bytes.length === 0) throw new XError("x media upload: empty bytes", 400);
      let res = await uploadRequest(bytes, mimeType);
      if (res.status === 401 && (await refresh())) {
        res = await uploadRequest(bytes, mimeType);
      }
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        classifyApiError(res.status, body, res.headers);
      }
      const j = (await res.json()) as { media_id_string?: string; media_id?: number | string };
      const mediaId = j.media_id_string ?? (j.media_id != null ? String(j.media_id) : "");
      if (!mediaId) throw new XError("x media upload returned no media_id", res.status);
      return { mediaId };
    },
    async postTweet({ text, inReplyToId, mediaIds }) {
      // RC3 — proactive refresh: if the OAuth2 access token is at/near expiry,
      // refresh BEFORE the first write instead of eating a 401 round-trip. With a
      // coordinator this also collapses the ~2h-boundary stampede (every writer
      // hits the same lock and reuses one rotation). Best-effort: on failure we
      // fall through and the reactive 401 path is the safety net. No-op on the
      // oauth1a path (no refreshToken/expiresAt).
      if (tokens.refreshToken && tokens.expiresAt && Date.now() >= tokens.expiresAt - 60_000) {
        await refresh();
      }
      // The single no-links chokepoint: top-level posts are stripped; replies keep links.
      const finalText = inReplyToId ? text : stripExternalLinksForPost(text);
      const payload: {
        text: string;
        reply?: { in_reply_to_tweet_id: string };
        media?: { media_ids: string[] };
      } = { text: finalText };
      if (inReplyToId) payload.reply = { in_reply_to_tweet_id: inReplyToId };
      const ids = (mediaIds ?? []).filter((m) => !!m).slice(0, MAX_TWEET_MEDIA);
      if (ids.length > 0) payload.media = { media_ids: ids };

      let res = await tweetRequest(payload);
      if (res.status === 401 && (await refresh())) {
        res = await tweetRequest(payload);
      }
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        if (res.status >= 500 || res.status === 408) {
          throw new XWriteUncertainError(`x post returned ${res.status}; check X before retrying`);
        }
        classifyApiError(res.status, body, res.headers);
      }
      const j = (await res.json().catch(() => null)) as { data?: { id?: unknown } } | null;
      const id = typeof j?.data?.id === "string" ? readXSourceId(j.data.id) : null;
      if (!id) {
        throw new XWriteUncertainError("x post returned no valid receipt; check X before retrying");
      }
      return { id, url: `https://x.com/${handle || "i"}/status/${id}` };
    },

    async getMyAccount() {
      let res = await meRequest();
      if (res.status === 401 && (await refresh())) res = await meRequest();
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        classifyApiError(res.status, body, res.headers); // 401/403/429 → typed throw
      }
      const j = (await res.json()) as {
        data?: {
          id?: string;
          username?: string;
          name?: string;
          public_metrics?: {
            followers_count?: number;
            following_count?: number;
            tweet_count?: number;
          };
        };
      };
      const d = j.data;
      if (!d?.id || !d.username) throw new XError("x users/me: malformed response", 502);
      const m = d.public_metrics ?? {};
      const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
      return {
        id: d.id,
        handle: d.username,
        displayName: typeof d.name === "string" && d.name ? d.name : null,
        followers: num(m.followers_count),
        following: num(m.following_count),
        posts: num(m.tweet_count),
      };
    },

    async getTweetMetrics(ids) {
      const unique = [...new Set(ids.filter((s) => /^\d+$/.test(s)))];
      if (unique.length === 0) return [];
      const out: TweetMetrics[] = [];
      for (const group of chunk(unique, TWEETS_LOOKUP_MAX)) {
        let res = await metricsRequest(group);
        if (res.status === 401 && (await refresh())) res = await metricsRequest(group);
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          classifyApiError(res.status, body, res.headers); // 401/403/429 → typed throw
        }
        // A 200 can still carry a partial `errors[]` (deleted/protected tweets)
        // alongside `data` — we take whatever `data` came back, never throw on it.
        const j = (await res.json()) as {
          data?: Array<{
            id?: string;
            public_metrics?: {
              like_count?: number;
              retweet_count?: number;
              reply_count?: number;
              quote_count?: number;
              impression_count?: number;
              bookmark_count?: number;
            };
          }>;
        };
        for (const t of j.data ?? []) {
          if (!t.id) continue;
          const m = t.public_metrics ?? {};
          out.push({
            id: t.id,
            views: measuredCount(m.impression_count),
            likes: measuredCount(m.like_count) ?? 0,
            reposts: measuredCount(m.retweet_count) ?? 0,
            replies: measuredCount(m.reply_count) ?? 0,
            quotes: measuredCount(m.quote_count),
            bookmarks: measuredCount(m.bookmark_count),
          });
        }
      }
      return out;
    },
  };
}
