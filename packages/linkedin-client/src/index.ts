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
  const clientVersion = opts.clientVersion ?? DEFAULT_CLIENT_VERSION;
  const profilePostsQueryId = opts.profilePostsQueryId ?? DEFAULT_PROFILE_POSTS_QUERY_ID;
  const profilePostsSectionType = opts.profilePostsSectionType ?? DEFAULT_PROFILE_POSTS_SECTION;
  const profilePostsPageType = opts.profilePostsPageType ?? DEFAULT_POSTS_PAGE_TYPE;
  const liTrack = JSON.stringify({
    clientVersion,
    mpVersion: clientVersion,
    osName: "web",
    timezoneOffset: -5,
    timezone: "America/Bogota",
    deviceFormFactor: "DESKTOP",
    mpName: "voyager-web",
  });

  const jar = new Map<string, string>();
  jar.set("li_at", opts.liAt);
  for (const [k, v] of Object.entries(opts.extraCookies ?? {})) jar.set(k, v);

  // If the caller supplies a current JSESSIONID (captured from the same browser
  // session as li_at), use it directly and skip minting via /feed/ entirely.
  // /feed/ minting is the rate-limit-sensitive surface; supplying the pair
  // sidesteps it. Re-mint via /feed/ still happens only on a genuine session
  // death. The csrf-token is the JSESSIONID with surrounding quotes stripped.
  let csrf: string | null = null;
  const bypassMode = Boolean(opts.jsessionid);
  if (opts.jsessionid) {
    const quoted = opts.jsessionid.startsWith('"') ? opts.jsessionid : `"${opts.jsessionid}"`;
    jar.set("JSESSIONID", quoted);
    csrf = opts.jsessionid.replace(/"/g, "");
  }

  function cookieHeader(): string {
    return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
  }

  /** Mint (or reuse) a fresh JSESSIONID bound to li_at. Cached until reset(). */
  async function ensureSession(): Promise<void> {
    if (csrf) return;
    // In bypass mode the caller supplied the JSESSIONID — do NOT fall back to
    // /feed/ minting (that re-mint under suspicion is what gets li_at logged out
    // with "li_at=delete me"). Surface expiry so the operator supplies a fresh
    // pair instead of burning the token.
    if (bypassMode) {
      throw new LinkedInAuthError(
        "supplied JSESSIONID expired — provide a fresh li_at + JSESSIONID pair",
        401,
      );
    }
    const res = await fetchImpl(MINT_URL, {
      method: "GET",
      redirect: "manual",
      headers: {
        "user-agent": ua,
        accept: "text/html,application/xhtml+xml",
        "accept-language": "en-US,en;q=0.9",
        "accept-encoding": "gzip, deflate, br",
        cookie: cookieHeader(),
      },
    });
    // Read Set-Cookie from headers only; do not download the (~9 MB) feed body.
    const setCookies =
      typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [];
    try {
      await res.body?.cancel();
    } catch {
      /* ignore */
    }
    for (const line of setCookies) {
      const kv = cookieFromSetCookie(line);
      if (kv) jar.set(kv[0], kv[1]);
    }
    const jsession = jar.get("JSESSIONID");
    if (!jsession) {
      throw new LinkedInAuthError("could not mint JSESSIONID (li_at invalid or IP blocked)", 401);
    }
    csrf = jsession.replace(/"/g, "");
  }

  function reset(): void {
    csrf = null;
    jar.delete("JSESSIONID");
  }

  let lastCallAt = 0;
  const callTimes: number[] = []; // timestamps of calls in the last rolling hour
  async function pace(): Promise<void> {
    const t0 = now();
    // Per-hour cap: prune the window, then refuse (don't sleep an hour) if full.
    if (maxCallsPerHour > 0) {
      const cutoff = t0 - 3_600_000;
      while (callTimes.length > 0 && callTimes[0]! < cutoff) callTimes.shift();
      if (callTimes.length >= maxCallsPerHour) {
        throw new LinkedInRateLimitError(
          `hourly call cap reached (${maxCallsPerHour}/h) — backing off`,
          429,
        );
      }
    }
    const since = t0 - lastCallAt;
    const wait = Math.max(0, minDelayMs - since) + Math.floor(Math.random() * jitterMs);
    if (wait > 0) await doSleep(wait);
    const t1 = now();
    lastCallAt = t1;
    callTimes.push(t1);
  }

  async function voyagerGet(
    path: string,
    opts: { retry?: boolean; headers?: Record<string, string> } = {},
  ): Promise<unknown> {
    const retry = opts.retry ?? true;
    await ensureSession();
    await pace();
    const res = await fetchImpl(`${VOYAGER_BASE}${path}`, {
      method: "GET",
      redirect: "manual",
      headers: {
        "user-agent": ua,
        accept: "application/vnd.linkedin.normalized+json+2.1",
        "accept-language": "en-US,en;q=0.9",
        "x-restli-protocol-version": "2.0.0",
        "x-li-lang": "en_US",
        "x-li-track": liTrack,
        "csrf-token": csrf as string,
        referer: "https://www.linkedin.com/feed/",
        cookie: cookieHeader(),
        ...(opts.headers ?? {}),
      },
    });
    if (res.status === 200) {
      return res.json();
    }
    const bodyText = await res.text().catch(() => "");
    const isCsrf = /csrf/i.test(bodyText);
    // Only re-mint when the SESSION is genuinely dead: a 302 to login, a 401, or
    // a 403 whose body is the CSRF-check failure. A plain 403/4xx on a specific
    // endpoint is NOT a session problem — surface it instead of re-minting
    // /feed/ in a loop (re-mint storms are exactly what gets the cookie
    // throttled). Re-mint at most once.
    const sessionDead = res.status === 302 || res.status === 401 || (res.status === 403 && isCsrf);
    if (sessionDead && retry) {
      reset();
      return voyagerGet(path, { retry: false, ...(opts.headers ? { headers: opts.headers } : {}) });
    }
    if (res.status === 429) throw new LinkedInRateLimitError();
    const snippet = bodyText.slice(0, 160).replace(/\s+/g, " ").trim() || "(no body)";
    if (sessionDead || res.status === 401 || res.status === 403) {
      throw new LinkedInAuthError(`linkedin ${res.status}: ${snippet}`, res.status);
    }
    throw new LinkedInError(`linkedin voyager ${res.status}: ${snippet}`, res.status);
  }

  function parseProfileEntity(e: Record<string, unknown>): LinkedInProfile | null {
    const urn =
      (e.entityUrn as string) ?? (e.dashEntityUrn as string) ?? (e["*miniProfile"] as string) ?? "";
    if (!/fsd_profile:|fs_miniProfile:/.test(urn)) return null;
    const first = (e.firstName as string) ?? "";
    const last = (e.lastName as string) ?? "";
    const name = `${first} ${last}`.trim() || null;
    const headline =
      (e.headline as string) ?? (e.occupation as string) ?? (e.title as string) ?? null;
    return {
      fsdProfileId: stripFsdPrefix(urn),
      publicId: (e.publicIdentifier as string) ?? null,
      name,
      headline,
    };
  }

  return {
    async me() {
      const json = await voyagerGet("/me");
      const miniRef =
        (json as { data?: { ["*miniProfile"]?: string } })?.data?.["*miniProfile"] ?? "";
      let fsd = stripFsdPrefix(miniRef);
      let name: string | null = null;
      for (const e of entitiesOf(json)) {
        const p = parseProfileEntity(e);
        if (p) {
          if (!fsd) fsd = p.fsdProfileId;
          name = p.name ?? name;
          break;
        }
      }
      if (!fsd) throw new LinkedInAuthError("could not resolve own profile from /me", 403);
      return { fsdProfileId: fsd, name };
    },

    async resolveProfile(slugOrUrl) {
      const slug = profileSlug(slugOrUrl);
      const json = await voyagerGet(
        `/identity/dash/profiles?q=memberIdentity&memberIdentity=${encodeURIComponent(slug)}`,
      );
      for (const e of entitiesOf(json)) {
        const p = parseProfileEntity(e);
        if (p && (p.publicId === slug || !p.publicId)) return p;
      }
      // Fall back to the first profile entity if the slug didn't match exactly.
      for (const e of entitiesOf(json)) {
        const p = parseProfileEntity(e);
        if (p) return p;
      }
      return null;
    },

    async memberPosts({ fsdProfileId, limit = 5, sinceISO }) {
      // GraphQL endpoint (the old REST finder voyagerFeedDashProfileUpdates is
      // dead). The urn's colons are %3A-encoded; the RestLi structural chars
      // ( ) : , stay literal. The query has no count param — it returns a page;
      // we slice to `limit` after parsing.
      const profileUrn = `urn%3Ali%3Afsd_profile%3A${encodeURIComponent(fsdProfileId)}`;
      const variables = `(profileUrn:${profileUrn},sectionType:${profilePostsSectionType})`;
      const qs = `includeWebMetadata=true&variables=${variables}&queryId=${profilePostsQueryId}`;
      const json = await voyagerGet(`/graphql?${qs}`, {
        headers: { "x-li-page-instance": `urn:li:page:${profilePostsPageType};${freshUuid()}` },
      });
      const since = sinceISO ? new Date(sinceISO).getTime() : 0;
      const seen = new Set<string>();
      const posts: LinkedInPost[] = [];
      for (const e of entitiesOf(json)) {
        const commentary = (e as { commentary?: { text?: { text?: string } } }).commentary;
        const text = commentary?.text?.text;
        if (!text) continue;
        const blob = JSON.stringify(e);
        const m = blob.match(/urn:li:activity:(\d+)/);
        const id = m?.[1];
        if (!id || seen.has(id)) continue;
        seen.add(id);
        const social = (e as {
          ["*socialDetail"]?: unknown;
          socialDetail?: { totalSocialActivityCounts?: { numLikes?: unknown; numComments?: unknown } };
        }).socialDetail?.totalSocialActivityCounts;
        const postedAt = timeFromActivityId(id);
        posts.push({
          id,
          urn: `urn:li:activity:${id}`,
          text,
          url: `https://www.linkedin.com/feed/update/urn:li:activity:${id}/`,
          postedAt,
          reactions: asNumber(social?.numLikes),
          comments: asNumber(social?.numComments),
        });
      }
      const filtered = since
        ? posts.filter((p) => !p.postedAt || new Date(p.postedAt).getTime() > since)
        : posts;
      return filtered.slice(0, limit);
    },

    async connections({ limit = 40, start = 0 } = {}) {
      // Best-effort: the legacy relationships/connections endpoint returns
      // miniProfile entities. If LinkedIn has retired it for this account the
      // call throws and the caller falls back to manual watchlist entry.
      const json = await voyagerGet(
        `/relationships/connections?q=viewer&count=${limit}&start=${start}&sortType=RECENTLY_ADDED`,
      );
      const out: LinkedInProfile[] = [];
      const seen = new Set<string>();
      for (const e of entitiesOf(json)) {
        const p = parseProfileEntity(e);
        if (p && p.fsdProfileId && !seen.has(p.fsdProfileId)) {
          seen.add(p.fsdProfileId);
          out.push(p);
        }
      }
      return out;
    },
  };
}
