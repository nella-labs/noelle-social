import { readXSourceId, readXSourceTimestamp } from "@noelle/x-client";

/** Browser observations are untrusted data, never classifier verdicts. */
export type XBrowserObservation = {
  tweetId: string;
  url: string;
  text: string;
  authorHandle: string;
  authorName?: string;
  authorId?: string;
  postedAt?: string;
  likeCount?: number;
  replyCount?: number;
};

export type NormalizedXObservation = Omit<XBrowserObservation, "postedAt"> & {
  postedAt: string | null;
};

export function normalizeXObservation(raw: XBrowserObservation): NormalizedXObservation | null {
  const tweetId = readXSourceId(raw.tweetId);
  const text = raw.text.trim();
  const authorHandle = raw.authorHandle.trim().replace(/^@/, "").toLowerCase();
  if (!tweetId || !text || text.length > 25_000 ||
      !/^[a-z0-9_]{1,15}$/.test(authorHandle) ||
      [raw.likeCount, raw.replyCount].some((n) => n != null && (!Number.isSafeInteger(n) || n < 0))) return null;

  let url: URL;
  try { url = new URL(raw.url); } catch { return null; }
  if (url.protocol !== "https:" || !["x.com", "www.x.com", "twitter.com", "www.twitter.com"].includes(url.hostname)) return null;
  const match = /^\/(?:([a-zA-Z0-9_]{1,15})|i)\/status\/(\d{1,25})\/?$/.exec(url.pathname);
  if (!match || match[2] !== tweetId) return null;
  if (match[1] && match[1].toLowerCase() !== "i" && match[1].toLowerCase() !== authorHandle) return null;
  return {
    ...raw, tweetId, text, authorHandle,
    url: `https://x.com/${(match[1] ?? "i").toLowerCase()}/status/${tweetId}`,
    postedAt: readXSourceTimestamp(raw.postedAt),
  };
}

export type XProfileTarget = { handle: string; lastCheckedAt: string | null; latestObservedPostAt: string | null };
export type XKeywordTarget = { value: string; lastCheckedAt: string | null };
export type XDiscoveryTarget = { kind: "profile"; handle: string } | { kind: "keyword"; value: string };

const stamp = (value: string | null) => value ? new Date(value).getTime() || 0 : 0;

/** Choose a topical keyword for three of five target reads; retain both watched-person priorities. */
export function chooseXDiscoveryTarget(
  profiles: XProfileTarget[], keywords: XKeywordTarget[], slot: number, nowMs: number,
): XDiscoveryTarget | null {
  const eligible = profiles.filter((p) => nowMs - stamp(p.lastCheckedAt) >= 4 * 3600_000);
  const phase = slot % 5;
  const oldestProfile = phase === 0;
  if (phase === 1 || phase === 2 || phase === 3 || eligible.length === 0) {
    const kw = [...keywords].sort((a, b) => stamp(a.lastCheckedAt) - stamp(b.lastCheckedAt))[0];
    if (kw) return { kind: "keyword", value: kw.value };
  }
  const selected = [...eligible].sort((a, b) => oldestProfile
    ? stamp(a.lastCheckedAt) - stamp(b.lastCheckedAt)
    : stamp(b.latestObservedPostAt) - stamp(a.latestObservedPostAt) || stamp(a.lastCheckedAt) - stamp(b.lastCheckedAt))[0];
  return selected ? { kind: "profile", handle: selected.handle } : null;
}
