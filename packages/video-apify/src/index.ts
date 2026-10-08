// Instagram + TikTok short-form video transport via Apify.
//
// Why: mirrors the other interns' Apify clients (@noelle/reddit-apify,
// @noelle/x-apify) so Nova's harvester can call it the same way. Apify runs the
// scrapers + proxies, so there are no IG/TikTok cookies, no login, no session
// death — we POST a creator handle (or a hashtag/niche keyword) + token and get
// their videos back, with engagement metrics.
//
// Read-only by design: this only FETCHES videos + account stats. Nova distils
// the winners into a Video Brand Guide and drafts scripts for the operator to
// record + post by hand. It NEVER posts to IG/TikTok.
//
// ONE client, TWO platforms (the plan's "TikTok = second lane, same client"):
// every method takes a `platform` and dispatches to the right actor + a
// defensive normalizer. Actor I/O varies by actor and plan tier — the input
// builders + normalizers below read many field aliases and the actor ids are
// overridable, so the exact actor is a build-time call (confirm against a live
// run in the harvester smoke test). Watch the apidojo demo-gating trap (a FREE
// plan silently gets {demo:true}); prefer a cheap, real actor.

import { assertApifyItemLimit, createApifyTransport } from "@noelle/runtime/apify-transport";
import { TERMINAL_APIFY_RUN_STATES, type ApifyRunReceipt } from "@noelle/runtime/apify-run-receipts";
import { readSourceCount, readSourceEpochTimestamp, readSourceNonnegativeNumber, readSourceTimestamp } from "@noelle/runtime/source-values";

// Apify slug form (username~name) — the run-sync endpoint accepts it, so there's
// no opaque hash to track. Overridable per client.
export const INSTAGRAM_ACTOR_ID = "apify~instagram-scraper";
export const TIKTOK_ACTOR_ID = "clockworks~tiktok-scraper";

// Dedicated hashtag/keyword DISCOVERY actors. The general apify~instagram-scraper
// above gets IG-blocked on its `hashtags` input (it 201s but every dataset item
// comes back {error:"no_items"} — IG hardened that GraphQL path in 2024-25).
// These two are maintained on a SEPARATE codebase/endpoint that still resolves
// topic feeds, so the niche/viral lane survives the block:
//   - search-scraper: a fuzzy keyword/topic -> trending ("popular") reels. Ideal
//     for the objective-driven lane (an objective is a topic, not a clean tag).
//   - hashtag-scraper: a concrete #hashtag -> recent top reels.
// Both are hashtag-lane ONLY (no creator lane) and return MIXED media, so the
// providers keep only video/reel items (Nova studies reels, not photos).
export const INSTAGRAM_SEARCH_ACTOR_ID = "apify~instagram-search-scraper";
export const INSTAGRAM_HASHTAG_ACTOR_ID = "apify~instagram-hashtag-scraper";

// Fallback Instagram actor, tried (creator lane only) when the primary yields no
// clips. apify/instagram-scraper periodically gets IG-blocked en masse: it still
// 201s but every dataset item comes back {error:"no_items","Empty or private
// data"} (or the run overruns the timeout). coderx is a separate vendor/backend,
// username-based, and returns the creator's recent posts under `latestPosts`, so
// it survives the apify-side blocks independently. It has no hashtag/niche lane.
export const INSTAGRAM_FALLBACK_ACTOR_ID = "coderx~instagram-profile-scraper-bio-posts";

export type VideoPlatform = "instagram" | "tiktok";

export class ApifyError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "ApifyError";
    this.status = status;
  }
}

/** Another paid attempt is allowed only after a confirmed terminal actor failure. */
export function isRetryableActorFailure(error: unknown): boolean {
  if (!(error instanceof ApifyError) || (error.status !== 400 && error.status !== 502)) return false;
  if (/\brun-failed\b/i.test(error.message)) return true;
  return Array.from(error.message.matchAll(/\b(?:run\s+|status:\s*)([a-z-]+)\b/gi)).some(match => {
    const state = match[1]!.toUpperCase();
    return state !== "SUCCEEDED" && TERMINAL_APIFY_RUN_STATES.has(state);
  });
}

export { checkApifyToken } from "@noelle/runtime/apify-token-health";
export type { ApifyTokenHealth } from "@noelle/runtime/apify-token-health";

// --- Result shapes -----------------------------------------------------------

/** One harvested short-form video — what the harvester upserts into video_clips. */
export interface VideoClip {
  /** Platform video id (shortcode/id). Used as video_clips.external_id. */
  id: string;
  platform: VideoPlatform;
  /** Canonical post URL. */
  url: string;
  /** Creator handle (no leading @). */
  authorHandle: string;
  caption: string;
  views: number | null;
  likes: number | null;
  comments: number | null;
  shares: number | null;
  saves: number | null;
  durationSec: number | null;
  musicId: string | null;
  musicName: string | null;
  /** Direct media URL for the extractor to download (may expire). */
  videoUrl: string | null;
  thumbUrl: string | null;
  /** Author follower count AT PULL TIME — the denominator for the outperformer ratio. */
  authorFollowerCount: number | null;
  /** ISO 8601 birth date, or null when unknown. */
  postedAt: string | null;
  /** The full Apify item, stored to video_clips.raw jsonb. */
  raw: unknown;
}

/** A creator account snapshot — Nova's "my account in real time" + per-creator stats. */
export interface AccountSnapshot {
  handle: string;
  platform: VideoPlatform;
  followerCount: number | null;
  followingCount: number | null;
  postCount: number | null;
  fullName: string | null;
  bio: string | null;
  /** Recent videos with metrics, when the actor returns them (may be empty). */
  recent: VideoClip[];
  raw: unknown;
}

// --- Defensive field readers -------------------------------------------------

function asStr(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/** Pick the first non-empty string among several candidate fields. */
function firstStr(...vals: unknown[]): string {
  for (const v of vals) {
    const s = asStr(v);
    if (s) return s;
  }
  return "";
}

// --- Instagram normalizer ----------------------------------------------------
// apify/instagram-scraper post item (subset, read defensively): id/shortCode,
// caption, videoViewCount/videoPlayCount/playCount, likesCount, commentsCount,
// videoUrl, displayUrl, ownerUsername, ownerFullName, timestamp, videoDuration,
// musicInfo{audio_id,song_name}, and (on profile/details runs) followersCount.
export function normalizeInstagramReel(raw: unknown): VideoClip | null {
  if (!raw || typeof raw !== "object") return null;
  const it = raw as Record<string, unknown>;
  const shortCode = firstStr(it.shortCode, it.code, it.shortcode);
  const id = firstStr(it.id, shortCode);
  if (!id) return null;
  const url = firstStr(it.url) || (shortCode ? `https://www.instagram.com/reel/${shortCode}/` : "");
  const owner = (it.owner ?? {}) as Record<string, unknown>;
  const music = (it.musicInfo ?? it.music ?? {}) as Record<string, unknown>;
  return {
    id,
    platform: "instagram",
    url,
    authorHandle: firstStr(it.ownerUsername, owner.username, it.username).toLowerCase(),
    caption: firstStr(it.caption, it.text, it.title),
    views: readSourceCount(it.videoViewCount, it.videoPlayCount, it.playCount, it.views, it.video_view_count, it.view_count),
    likes: readSourceCount(it.likesCount, it.likeCount, it.likes),
    comments: readSourceCount(it.commentsCount, it.commentCount, it.comments),
    shares: readSourceCount(it.sharesCount, it.shareCount, it.reshareCount),
    saves: readSourceCount(it.savesCount, it.saveCount, it.bookmarkCount),
    durationSec: readSourceNonnegativeNumber(it.videoDuration, it.duration),
    musicId: firstStr(music.audio_id, music.audioId, music.id) || null,
    musicName: firstStr(music.song_name, music.songName, music.title, music.name) || null,
    videoUrl: firstStr(it.videoUrl, it.videoUrlBackup) || null,
    thumbUrl: firstStr(it.displayUrl, it.thumbnailUrl, it.thumbnail) || null,
    authorFollowerCount: readSourceCount(it.ownerFollowersCount, owner.followersCount, it.followersCount),
    postedAt: readSourceTimestamp(it.timestamp, it.takenAt, it.taken_at)
      ?? readSourceEpochTimestamp(it.taken_at_timestamp, "seconds"),
    raw,
  };
}

// --- TikTok normalizer -------------------------------------------------------
// clockworks/tiktok-scraper item (subset): id, text, playCount, diggCount
// (likes), commentCount, shareCount, collectCount (saves), webVideoUrl,
// videoMeta{duration,coverUrl,downloadAddr}, musicMeta{musicId,musicName},
// authorMeta{name,fans}, createTimeISO/createTime.
export function normalizeTiktokVideo(raw: unknown): VideoClip | null {
  if (!raw || typeof raw !== "object") return null;
  const it = raw as Record<string, unknown>;
  const id = firstStr(it.id, it.videoId, it.awemeId);
  if (!id) return null;
  const author = (it.authorMeta ?? it.author ?? {}) as Record<string, unknown>;
  const videoMeta = (it.videoMeta ?? {}) as Record<string, unknown>;
  const musicMeta = (it.musicMeta ?? it.music ?? {}) as Record<string, unknown>;
  const handle = firstStr(author.name, author.uniqueId, author.nickName, it.authorName).toLowerCase();
  const url = firstStr(it.webVideoUrl, it.url) || (handle ? `https://www.tiktok.com/@${handle}/video/${id}` : "");
  return {
    id,
    platform: "tiktok",
    url,
    authorHandle: handle,
    caption: firstStr(it.text, it.desc, it.caption),
    views: readSourceCount(it.playCount, it.viewCount, it.views),
    likes: readSourceCount(it.diggCount, it.likeCount, it.likes),
    comments: readSourceCount(it.commentCount, it.comments),
    shares: readSourceCount(it.shareCount, it.shares),
    saves: readSourceCount(it.collectCount, it.saveCount, it.saves),
    durationSec: readSourceNonnegativeNumber(videoMeta.duration, it.duration),
    musicId: firstStr(musicMeta.musicId, musicMeta.id) || null,
    musicName: firstStr(musicMeta.musicName, musicMeta.title, musicMeta.name) || null,
    videoUrl: firstStr(videoMeta.downloadAddr, it.videoUrl, videoMeta.playAddr) || null,
    thumbUrl: firstStr(videoMeta.coverUrl, it.covers, videoMeta.cover) || null,
    authorFollowerCount: readSourceCount(author.fans, author.followerCount, author.followers),
    postedAt: readSourceTimestamp(it.createTimeISO, it.createTimestamp)
      ?? readSourceEpochTimestamp(it.createTime, "seconds"),
    raw,
  };
}

function normalizerFor(platform: VideoPlatform): (raw: unknown) => VideoClip | null {
  return platform === "tiktok" ? normalizeTiktokVideo : normalizeInstagramReel;
}

// --- Client ------------------------------------------------------------------

export interface CreateApifyVideoClientOpts {
  /** Apify API token. The only credential — no IG/TikTok cookies. */
  token: string;
  baseUrl?: string;
  /** Override the Instagram actor (default apify~instagram-scraper). */
  instagramActorId?: string;
  /** Override the IG keyword/topic discovery actor (default apify~instagram-search-scraper). */
  instagramSearchActorId?: string;
  /** Override the IG hashtag discovery actor (default apify~instagram-hashtag-scraper). */
  instagramHashtagActorId?: string;
  /** Override the TikTok actor (default clockworks~tiktok-scraper). */
  tiktokActorId?: string;
  /**
   * OPT-IN, default OFF. Route TikTok niche discovery through the clockworks
   * `searchQueries` keyword input instead of the hashtag lane. UNVERIFIED: the
   * exact clockworks input field is not confirmed in-repo — run ONE live harvest
   * to confirm `searchQueries` actually returns videos before wiring this on in
   * prod (see docs/content-studio.md "Activating TikTok"). When off, TikTok niche
   * stays hashtag-based (nicheCreatorReels → hashtagReels), which is the tested,
   * shipped default.
   */
  tiktokKeywordSearch?: boolean;
  /** Max wait for a synchronous actor run (ms). Default 120000. */
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export interface ApifyVideoClient {
  /** Independent logical-operation state, provided by rotating client facades. */
  isolateOperation?(): ApifyVideoClient;
  /** A creator's recent videos, newest first, with engagement metrics. */
  creatorReels(args: {
    platform: VideoPlatform;
    handle: string;
    maxItems?: number;
    /** Drop videos older than this ISO time (recency window). */
    sinceISO?: string;
  }): Promise<VideoClip[]>;
  /** Videos for a niche keyword/hashtag (the "newest top performers in a niche" lane). */
  hashtagReels(args: {
    platform: VideoPlatform;
    query: string;
    maxItems?: number;
    sinceISO?: string;
  }): Promise<VideoClip[]>;
  /**
   * Niche discovery by PROFILE: find creators who post in the niche
   * (searchType:"user") and harvest each one's recent reels, merged. More
   * reliable than hashtag matching — a reel rarely carries the niche keyword,
   * but a creator who consistently posts it is a strong signal. Instagram only;
   * TikTok falls back to hashtagReels. Falls back to hashtagReels if profile
   * discovery finds nothing.
   */
  nicheCreatorReels(args: {
    platform: VideoPlatform;
    query: string;
    maxItems?: number;
    /** Max creators to discover + harvest for the niche. */
    maxCreators?: number;
    sinceISO?: string;
  }): Promise<VideoClip[]>;
  /** A creator's account snapshot (follower count + recent videos). */
  accountSnapshot(args: {
    platform: VideoPlatform;
    handle: string;
    recentLimit?: number;
  }): Promise<AccountSnapshot>;
  /** Final reported charges for every run in the current operation. */
  drainRunReceipts?(): ApifyRunReceipt[];
  /** Legacy single drain; null when any run's actual charge is unknown. */
  drainLastRunUsd?(): number | null;

}

function igProfileUrl(handle: string): string {
  return `https://www.instagram.com/${handle.replace(/^@/, "")}/`;
}

// A niche label -> its Instagram hashtag explore URL. IG hashtags are a single
// token, so strip the leading #, spaces, and punctuation and lowercase:
// "YC Founders" -> #ycfounders, "Building in Public" -> #buildinginpublic.
function igExploreTagUrl(query: string): string {
  const tag = query.replace(/^#/, "").toLowerCase().replace(/[^a-z0-9]/g, "");
  return `https://www.instagram.com/explore/tags/${tag}/`;
}

// --- Instagram provider chain ------------------------------------------------
// One IG source actor + how to drive and read it. The client tries these in
// order and uses the first that yields clips, so a single actor's IG-block
// outage (or a free-tier gate) auto-falls-through to the next instead of
// failing the whole harvest.
interface IgProvider {
  actorId: string;
  /** Creator-posts input, or null when the actor has no creator lane. */
  creatorInput(handle: string, maxItems: number): unknown | null;
  /** Hashtag/niche input, or null when the actor has no hashtag lane. */
  hashtagInput(tag: string, maxItems: number): unknown | null;
  /** Flatten the dataset into individual post records for normalizeInstagramReel. */
  extract(items: unknown[]): unknown[];
}

// Primary: apify/instagram-scraper (and any drop-in override). Standard
// directUrls/hashtags input; the dataset items are already per-post.
function apifyIgProvider(actorId: string): IgProvider {
  return {
    actorId,
    creatorInput: (handle, maxItems) => ({
      directUrls: [igProfileUrl(handle)],
      resultsType: "posts",
      resultsLimit: maxItems,
      addParentData: false,
    }),
    // Niche/hashtag lane: the general scraper's `hashtags` field yields nothing,
    // so drive it by the hashtag's explore/tags URL and ask for reels (videos
    // only). This is the LAST-resort hashtag source behind the dedicated
    // discovery actors, so it catches niches they return empty for.
    hashtagInput: (tag, maxItems) => ({
      directUrls: [igExploreTagUrl(tag)],
      resultsType: "reels",
      resultsLimit: maxItems,
      addParentData: false,
    }),
    extract: (items) => items,
  };
}

// Keep only video/reel items — the search + hashtag discovery actors return
// MIXED media (photos, sidecars, reels). The type marker varies by actor, so read
// defensively: an explicit video-ish `type`/`productType`, or a truthy video
// field. Photos (views 0, no videoUrl) are dropped so Nova studies reels only.
function igVideoItems(items: unknown[]): unknown[] {
  return items.filter((raw) => {
    if (!raw || typeof raw !== "object") return false;
    const it = raw as Record<string, unknown>;
    const type = asStr(it.type ?? it.productType ?? it.mediaType ?? it.media_type).toLowerCase();
    if (type.includes("video") || type === "clips" || type === "reel" || type === "2") return true;
    return Boolean(it.videoUrl ?? it.videoViewCount ?? it.videoPlayCount ?? it.videoDuration);
  });
}

// Discovery: a fuzzy keyword/topic -> trending reels via searchType:"popular".
// Hashtag-lane only (creatorInput -> null, skipped on the creator chain). The
// "popular" feed can be empty for an obscure topic — igVideoItems then yields []
// and runIgChain falls through to the hashtag actor.
function igSearchProvider(actorId: string): IgProvider {
  return {
    actorId,
    creatorInput: () => null,
    hashtagInput: (tag, maxItems) => ({
      search: tag,
      searchType: "popular",
      searchLimit: maxItems,
    }),
    extract: igVideoItems,
  };
}

// Discovery: a concrete hashtag -> recent top reels (resultsType:"reels").
// keywordSearch lets a bare word resolve to its hashtag. Hashtag-lane only.
function igHashtagProvider(actorId: string): IgProvider {
  return {
    actorId,
    creatorInput: () => null,
    hashtagInput: (tag, maxItems) => ({
      hashtags: [tag.replace(/\s+/g, "")],
      resultsType: "reels",
      resultsLimit: maxItems,
      keywordSearch: true,
    }),
    extract: igVideoItems,
  };
}

// Fallback: coderx returns ONE profile object per username with the recent posts
// nested under `latestPosts`; lift them out and graft the profile's handle +
// follower count onto each so normalizeInstagramReel can read author fields.
// Username-based, so there is no hashtag lane (hashtagInput -> null).
const coderxIgProvider: IgProvider = {
  actorId: INSTAGRAM_FALLBACK_ACTOR_ID,
  creatorInput: (handle) => ({ usernames: [handle] }),
  hashtagInput: () => null,
  extract: (items) =>
    items.flatMap((item) => {
      const profile = (item ?? {}) as Record<string, unknown>;
      const posts = Array.isArray(profile.latestPosts) ? profile.latestPosts : [];
      const username = asStr(profile.username);
      const followers = profile.followersCount;
      return posts.map((post) => {
        const p = (post ?? {}) as Record<string, unknown>;
        return {
          ...p,
          ownerUsername: firstStr(p.ownerUsername, username),
          ownerFollowersCount: p.ownerFollowersCount ?? followers,
        };
      });
    }),
};

export function createApifyVideoClient(opts: CreateApifyVideoClientOpts): ApifyVideoClient {
  const transport = createApifyTransport({
    token: opts.token,
    ...(opts.baseUrl ? { baseUrl: opts.baseUrl } : {}),
    ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
    ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
    errorFactory: (message, status) => new ApifyError(message, status),
  });
  const tiktokActorId = opts.tiktokActorId ?? TIKTOK_ACTOR_ID;
  // OPT-IN, default OFF. See CreateApifyVideoClientOpts.tiktokKeywordSearch —
  // UNVERIFIED clockworks input; confirm with one live run before prod use.
  const tiktokKeywordSearch = opts.tiktokKeywordSearch ?? false;
  // The general scraper's actor — also the details/snapshot actor (the discovery
  // actors don't do profile details), so it's named once and reused below.
  const igDetailsActorId = opts.instagramActorId ?? INSTAGRAM_ACTOR_ID;
  // IG provider chain. Hashtag/keyword lane: the dedicated discovery actors FIRST
  // (they survive the IG block that kills the general scraper's hashtag path),
  // then the general scraper as a last resort. Creator lane: the discovery actors
  // return null and are skipped, so creator harvest is unchanged — general
  // scraper, then coderx fallback. TikTok stays a single actor (independent block
  // profile, no equivalent split).
  const igSearchActorId = opts.instagramSearchActorId ?? INSTAGRAM_SEARCH_ACTOR_ID;
  const igProviders: IgProvider[] = [
    igSearchProvider(igSearchActorId),
    igHashtagProvider(opts.instagramHashtagActorId ?? INSTAGRAM_HASHTAG_ACTOR_ID),
    apifyIgProvider(igDetailsActorId),
    coderxIgProvider,
  ];

  async function runActorSync(actorId: string, input: unknown, itemLimit: number): Promise<unknown[]> {
    const actor = actorId.includes("~") ? actorId.split("~").at(-1)! : actorId;
    return (await transport.runActor({ actorId, actor, input, itemLimit })).items;
  }

  function normalizeAll(platform: VideoPlatform, items: unknown[], maxItems: number, sinceISO?: string): VideoClip[] {
    const normalize = normalizerFor(platform);
    const sourceSince = readSourceTimestamp(sinceISO);
    const since = sourceSince ? new Date(sourceSince).getTime() : null;
    const seen = new Set<string>();
    const out: VideoClip[] = [];
    for (const item of items) {
      const clip = normalize(item);
      if (!clip || seen.has(clip.id)) continue;
      // Recency floor — keep clips with no timestamp (dropping would lose data).
      if (since !== null && clip.postedAt && new Date(clip.postedAt).getTime() < since) continue;
      seen.add(clip.id);
      out.push(clip);
    }
    return out.slice(0, maxItems);
  }

  // Run the IG provider chain for a creator or hashtag lane. Returns the first
  // provider's clips that come back non-empty. A confirmed terminal failure or
  // completed empty response may advance to the next provider. Ambiguous paid
  // dispatch, dataset and token failures surface immediately.
  async function runIgChain(
    lane: "creator" | "hashtag",
    arg: string,
    maxItems: number,
    sinceISO: string | undefined,
  ): Promise<VideoClip[]> {
    let firstErr: unknown = null;
    let sawCleanResponse = false;
    for (const provider of igProviders) {
      const input =
        lane === "creator" ? provider.creatorInput(arg, maxItems) : provider.hashtagInput(arg, maxItems);
      if (input == null) continue; // provider has no lane for this kind (coderx + hashtag)
      let items: unknown[];
      try {
        items = await runActorSync(provider.actorId, input, maxItems);
      } catch (err) {
        if (!isRetryableActorFailure(err)) throw err;
        firstErr ??= err;
        continue;
      }
      sawCleanResponse = true;
      const clips = normalizeAll("instagram", provider.extract(items), maxItems, sinceISO);
      if (clips.length > 0) return clips;
    }
    if (!sawCleanResponse && firstErr) throw firstErr;
    return [];
  }

  async function fetchHashtagReels({ platform, query, maxItems = 30, sinceISO }: Parameters<ApifyVideoClient["hashtagReels"]>[0]): Promise<VideoClip[]> {
    if (!query) throw new ApifyError("hashtagReels requires a query", 0);
    const tag = query.replace(/^#/, "");
    if (platform === "instagram") return runIgChain("hashtag", tag, maxItems, sinceISO);
    const items = await runActorSync(tiktokActorId, {
      hashtags: [tag],
      resultsPerPage: maxItems,
      shouldDownloadVideos: false,
      shouldDownloadCovers: false,
    }, maxItems);
    return normalizeAll(platform, items, maxItems, sinceISO);
  }

  return {
    drainLastRunUsd: transport.drainLastRunUsd,
    drainRunReceipts: transport.drainRunReceipts,
    async creatorReels({ platform, handle, maxItems = 30, sinceISO }) {
      transport.beginOperation();
      if (!handle) throw new ApifyError("creatorReels requires a handle", 0);
      const clean = handle.replace(/^@/, "");
      if (platform === "instagram") return runIgChain("creator", clean, maxItems, sinceISO);
      const items = await runActorSync(tiktokActorId, {
        profiles: [clean],
        resultsPerPage: maxItems,
        shouldDownloadVideos: false,
        shouldDownloadCovers: false,
      }, maxItems);
      return normalizeAll(platform, items, maxItems, sinceISO);
    },

    async hashtagReels(args) {
      transport.beginOperation();
      return fetchHashtagReels(args);
    },

    async nicheCreatorReels({ platform, query, maxItems = 30, maxCreators = 4, sinceISO }) {
      transport.beginOperation();
      assertApifyItemLimit(maxItems, (message, status) => new ApifyError(message, status));
      if (platform === "instagram") assertApifyItemLimit(maxCreators, (message, status) => new ApifyError(message, status));
      if (maxItems === 0) return [];
      if (!query) throw new ApifyError("nicheCreatorReels requires a query", 0);
      // TikTok has no user-search that returns profiles, so niche discovery is
      // hashtag-based there by default. OPT-IN (tiktokKeywordSearch, default
      // OFF): route through the clockworks `searchQueries` keyword input instead.
      // UNVERIFIED — confirm the shape returns videos with one live run before
      // enabling in prod (see docs/content-studio.md "Activating TikTok").
      if (platform !== "instagram") {
        if (platform === "tiktok" && tiktokKeywordSearch) {
          const items = await runActorSync(tiktokActorId, {
            searchQueries: [query.replace(/^#/, "")],
            resultsPerPage: maxItems,
            shouldDownloadVideos: false,
            shouldDownloadCovers: false,
          }, maxItems);
          return normalizeAll(platform, items, maxItems, sinceISO);
        }
        return fetchHashtagReels({ platform, query, maxItems, ...(sinceISO ? { sinceISO } : {}) });
      }

      // 1. Discover creators who post in the niche (searchType:"user"). A person
      //    who uploads in a niche is a more reliable signal than a hashtag a reel
      //    may not even carry.
      let handles: string[] = [];
      try {
        const users = await runActorSync(igSearchActorId, {
          search: query.replace(/^#/, ""),
          searchType: "user",
          searchLimit: maxCreators,
        }, maxCreators);
        const seenH = new Set<string>();
        for (const u of users) {
          const name = asStr((u as Record<string, unknown>)?.username).toLowerCase();
          if (name && !seenH.has(name)) {
            seenH.add(name);
            handles.push(name);
          }
          if (handles.length >= maxCreators) break;
        }
      } catch (err) {
        if (!isRetryableActorFailure(err)) throw err;
        handles = [];
      }

      // 2. Harvest each discovered creator's recent reels via the creator chain
      //    and merge (dedupe by clip id). Per-creator failures are skipped.
      const seen = new Set<string>();
      const out: VideoClip[] = [];
      for (const h of handles) {
        if (out.length >= maxItems) break;
        let clips: VideoClip[] = [];
        try {
          clips = await runIgChain("creator", h, maxItems - out.length, sinceISO);
        } catch (err) {
          if (!isRetryableActorFailure(err)) throw err;
          clips = [];
        }
        for (const c of clips) {
          if (!seen.has(c.id)) {
            seen.add(c.id);
            out.push(c);
          }
        }
      }

