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
