// READ-ONLY LinkedIn Voyager client for the LinkedIn intern (Lyra).
//
// Why this exists / what makes it work (validated 2026-06-08 from the Lima VM —
// openclaw's LinkedIn was dead on a GCP datacenter IP):
//   1. RESIDENTIAL IP. Must run on a residential egress (the Lima VM NATs through
//      the Mac). Datacenter IPs 302 and permanently burn the cookie.
//   2. FRESH JSESSIONID. The DevTools/pasted JSESSIONID is stale → 403 "CSRF
//      check failed". We GET an authenticated page with li_at, take the
//      JSESSIONID LinkedIn Set-Cookies, and use THAT as both the JSESSIONID
//      cookie and the csrf-token header. So `li_at` is the only real credential.
//
// Deliberately READ-ONLY: there is no comment/like/connect/message method. Lyra
// drafts for human approval and never posts. Keep it that way.
//
// Pacing (the operator's note: don't hammer): we mint the session ONCE and cache it
// (rapid /feed/ loads get soft-rate-limited), we read JSON only (post media —
// images/videos — is never fetched), default batch sizes are small, and every
// Voyager call waits a jittered delay. Callers asking for deep history (the
// profiler) pass an explicit larger limit.

const VOYAGER_BASE = "https://www.linkedin.com/voyager/api";
const MINT_URL = "https://www.linkedin.com/feed/";
const DEFAULT_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) " +
  "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";
// Current voyager-web client version (from a live capture 2026-06-08). Sent in
// x-li-track; LinkedIn bumps it on web releases but tolerates a recent value.
const DEFAULT_CLIENT_VERSION = "1.13.44642";
// Member posts come from the GraphQL endpoint now (the old REST finder
// voyagerFeedDashProfileUpdates is dead): voyagerIdentityDashProfileComponents
// with sectionType=content-collections. LinkedIn rotates the queryId hash on web
// releases, so it's overridable via opts; this default was captured 2026-06-08.
const DEFAULT_PROFILE_POSTS_QUERY_ID =
  "voyagerIdentityDashProfileComponents.79eb2eecf0510d076d4b7b25b7a3fcde";
const DEFAULT_PROFILE_POSTS_SECTION = "content-collections";
// The graphql profile-components query is rejected without a page-instance
// header (me()/identity work without one, but this finder needs it). The uuid
// is per-request tracking; LinkedIn validates the page type, not the uuid.
const DEFAULT_POSTS_PAGE_TYPE = "d_flagship3_profile_view_base_recent_activity_content_view";

function freshUuid(): string {
  try {
    return (globalThis.crypto as Crypto).randomUUID();
  } catch {
    return "00000000-0000-4000-8000-000000000000";
  }
}

export class LinkedInError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "LinkedInError";
    this.status = status;
  }
}
export class LinkedInAuthError extends LinkedInError {
  constructor(message = "linkedin auth failed", status = 403) {
    super(message, status);
    this.name = "LinkedInAuthError";
  }
}
export class LinkedInRateLimitError extends LinkedInError {
  constructor(message = "linkedin rate limited", status = 429) {
    super(message, status);
    this.name = "LinkedInRateLimitError";
  }
}

export interface LinkedInPost {
  /** Numeric activity id (the `<id>` in urn:li:activity:<id>). */
  id: string;
  urn: string;
  text: string;
  url: string;
  /** ISO 8601. Derived from the activity id (first 41 bits = unix ms); '' if unparseable. */
  postedAt: string;
  reactions: number | null;
  comments: number | null;
}

export interface LinkedInProfile {
  /** urn:li:fsd_profile:<id> with the prefix stripped — the stable person key. */
  fsdProfileId: string;
  /** Vanity slug (linkedin.com/in/<publicId>). */
  publicId: string | null;
  name: string | null;
  headline: string | null;
}

export interface LinkedInClient {
  /** Auth/health check — returns the logged-in user's own fsd profile id. */
  me(): Promise<{ fsdProfileId: string; name: string | null }>;
  /** Resolve a profile URL or vanity slug to { fsdProfileId, publicId, name, headline }. */
  resolveProfile(slugOrUrl: string): Promise<LinkedInProfile | null>;
  /** A person's recent posts (member share feed). Small `limit` by default; the profiler passes ~40. */
  memberPosts(args: { fsdProfileId: string; limit?: number; sinceISO?: string }): Promise<LinkedInPost[]>;
  /** Best-effort: the logged-in user's connections (used to seed the watchlist). */
  connections(args?: { limit?: number; start?: number }): Promise<LinkedInProfile[]>;
}

export interface CreateLinkedInClientOpts {
  /** The only required credential. Everything else (JSESSIONID, csrf) is derived. */
  liAt: string;
  /** Optional extra cookies to seed the jar (rarely needed; li_at is enough). */
  extraCookies?: Record<string, string>;
  /** A current JSESSIONID captured alongside li_at (same session). When set, the
   *  client uses it directly and skips minting via /feed/ — sidesteps the
   *  /feed/ rate limit. Re-mint still kicks in only on a genuine session death. */
  jsessionid?: string;
  userAgent?: string;
  /** Min delay before each Voyager call (ms). Default 1500. */
  minDelayMs?: number;
  /** Random extra wait added on top of minDelayMs (ms). Default = minDelayMs. A
   *  worker wanting human cadence sets e.g. minDelayMs=20000, jitterMs=70000 for
   *  a 20–90s window between calls. */
  jitterMs?: number;
  /** Hard ceiling on Voyager calls in any rolling hour. When exceeded, pace()
   *  throws LinkedInRateLimitError so the caller backs off (cadence, not a ban).
   *  0/undefined = no cap. Only meaningful when the client is reused across
   *  ticks (one session per process). */
  maxCallsPerHour?: number;
  /** Injectable fetch for tests. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Injectable sleep for tests (defaults to setTimeout). */
  sleepImpl?: (ms: number) => Promise<void>;
  /** Injectable clock for tests (defaults to Date.now). */
  nowImpl?: () => number;
  /** GraphQL queryId for member posts. Rotates on LinkedIn web releases —
   *  override when the default stops returning posts. */
  profilePostsQueryId?: string;
  /** sectionType passed to voyagerIdentityDashProfileComponents (default
   *  "content-collections" — a member's activity/posts). */
  profilePostsSectionType?: string;
  /** page type for the x-li-page-instance header on the posts query. */
  profilePostsPageType?: string;
  /** voyager-web clientVersion for x-li-track. */
  clientVersion?: string;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** LinkedIn activity ids embed unix-ms in the high bits (first 41 bits). */
function timeFromActivityId(id: string): string {
  try {
    const ms = Number(BigInt(id) >> 22n);
    if (Number.isFinite(ms) && ms > 1_000_000_000_000 && ms < 4_000_000_000_000) {
      return new Date(ms).toISOString();
    }
  } catch {
    /* not a bigint */
  }
  return "";
}

/** Parse one `name=value` out of a Set-Cookie line. */
function cookieFromSetCookie(line: string): [string, string] | null {
  const first = line.split(";", 1)[0]?.trim();
  if (!first) return null;
  const eq = first.indexOf("=");
  if (eq <= 0) return null;
  return [first.slice(0, eq), first.slice(eq + 1)];
}

/** Pull the vanity slug out of a profile URL, or pass through a bare slug. */
export function profileSlug(slugOrUrl: string): string {
  const m = slugOrUrl.match(/\/in\/([^/?#]+)/);
  const slug = (m?.[1] ?? slugOrUrl).trim().replace(/^@/, "");
  return decodeURIComponent(slug);
}

/** Collect every `included`/`elements` entity from a Voyager normalized response. */
function entitiesOf(json: unknown): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  const j = json as { included?: unknown[]; data?: { elements?: unknown[]; included?: unknown[] } };
  for (const arr of [j?.included, j?.data?.included, j?.data?.elements]) {
    if (Array.isArray(arr)) {
      for (const e of arr) if (e && typeof e === "object") out.push(e as Record<string, unknown>);
    }
  }
  return out;
}

function asNumber(v: unknown): number | null {
  const n = typeof v === "string" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) ? n : null;
}

function stripFsdPrefix(urn: string): string {
  return urn.replace(/^urn:li:fsd_profile:/, "").replace(/^urn:li:fs_miniProfile:/, "");
}

export function createLinkedInClient(opts: CreateLinkedInClientOpts): LinkedInClient {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const doSleep = opts.sleepImpl ?? sleep;
  const ua = opts.userAgent ?? DEFAULT_UA;
  const minDelayMs = opts.minDelayMs ?? 1500;
  const jitterMs = opts.jitterMs ?? minDelayMs;
  const maxCallsPerHour = opts.maxCallsPerHour ?? 0;
  const now = opts.nowImpl ?? Date.now;
