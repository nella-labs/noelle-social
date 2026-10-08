/** Browser observations are data from the signed-in actor, never classifier claims. */
import { createHash } from "node:crypto";

export type BrowserObservation = {
  fingerprint?: string;
  urn?: string;
  url?: string;
  text: string;
  authorName?: string;
  authorHeadline?: string;
  authorHandle?: string;
  authorId?: string;
  postedAt?: string;
  reactionCount?: number;
  commentCount?: number;
};

export type NormalizedBrowserObservation = Omit<BrowserObservation, "postedAt"> & {
  externalId: string;
  postedAt: string | null;
};

/** Opaque provisional identity keeps Jev scoring independent of a permalink. */
export function normalizeBrowserObservation(
  raw: BrowserObservation, instanceId: string,
): NormalizedBrowserObservation | null {
  const fingerprint = raw.fingerprint?.trim();
  if ((fingerprint && fingerprint.length > 500) ||
      [raw.reactionCount, raw.commentCount].some((count) => count != null && (!Number.isSafeInteger(count) || count < 0))) return null;
  const canonical = normalizeObservation(raw);
  if (canonical) return { ...canonical, ...(fingerprint ? { fingerprint } : {}) };

  // An activity identifier with a bad or conflicting URL is invalid. A card
  // without either identifier is safe to stage, but it cannot be drafted yet.
  if (raw.urn || raw.url || !fingerprint) return null;
  const text = raw.text.trim();
  if (!text || text.length > 10_000) return null;
  const parsedDate = raw.postedAt ? new Date(raw.postedAt) : null;
  const externalId = `browser:${createHash("sha256").update(instanceId).update("\0").update(fingerprint).digest("hex")}`;
  const { urn: _urn, url: _url, postedAt: _postedAt, ...rest } = raw;
  return {
    ...rest, fingerprint, text, externalId,
    postedAt: parsedDate && Number.isFinite(parsedDate.getTime()) ? parsedDate.toISOString() : null,
  };
}

export function normalizeObservation(raw: BrowserObservation): (Omit<BrowserObservation, "urn" | "url" | "postedAt"> & {
  externalId: string;
  urn: string;
  url: string;
  postedAt: string | null;
}) | null {
  const text = raw.text.trim();
  if (!text || text.length > 10_000) return null;
  let url: URL | null = null;
  if (raw.url) {
    try { url = new URL(raw.url); } catch { return null; }
    if (url.protocol !== "https:" || url.hostname !== "www.linkedin.com") return null;
  }
  const urnId = /(?:^urn:li:activity:|activity[-:])(\d{10,})/i.exec(raw.urn ?? "")?.[1];
  const urlId = /activity[-:](\d{10,})/i.exec(url?.pathname ?? "")?.[1];
  if (url && !urlId) return null;
  if (urnId && urlId && urnId !== urlId) return null;
  const id = urnId ?? urlId;
  if (!id) return null;
  if (raw.urn && raw.urn !== `urn:li:activity:${id}`) return null;
  const parsedDate = raw.postedAt ? new Date(raw.postedAt) : null;
  return {
    ...raw,
    text,
    externalId: id,
    urn: `urn:li:activity:${id}`,
    url: url?.toString() ?? `https://www.linkedin.com/feed/update/urn:li:activity:${id}/`,
    postedAt: parsedDate && Number.isFinite(parsedDate.getTime()) ? parsedDate.toISOString() : null,
  };
}

export type ProfileTarget = {
  id: string;
  publicId: string | null;
  lastCheckedAt: string | null;
  latestObservedPostAt: string | null;
};
export type KeywordTarget = { id: string; value: string; lastCheckedAt: string | null };
export type PendingProfileTarget = { publicId: string; lastCheckedAt: string | null; latestPendingAt: string | null };
export type DiscoveryTarget = { kind: "profile" | "keyword"; id: string; url: string; source?: "pending" };

const stamp = (value: string | null) => value ? new Date(value).getTime() || 0 : 0;
const safePublicId = (value: string) => /^[A-Za-z0-9][A-Za-z0-9._-]{1,98}[A-Za-z0-9]$/.test(value);
const PROFILE_COOLDOWN_MS = 4 * 3600_000;
const PENDING_IDENTITY_COOLDOWN_MS = 5 * 60_000;

/** One choice per existing ambient navigation slot; no additional tab visits. */
export function chooseDiscoveryTarget(
  profiles: ProfileTarget[], keywords: KeywordTarget[], slot: number, nowMs: number,
  pendingProfiles: PendingProfileTarget[] = [],
): DiscoveryTarget | null {
  const eligible = profiles.filter((p) => p.publicId && nowMs - stamp(p.lastCheckedAt) >= PROFILE_COOLDOWN_MS);
  const pending = pendingProfiles.filter((p) => {
    if (!safePublicId(p.publicId)) return false;
    if (!p.lastCheckedAt) return true;
    const checkedAt = Date.parse(p.lastCheckedAt);
    return Number.isFinite(checkedAt) && nowMs - checkedAt >= PENDING_IDENTITY_COOLDOWN_MS;
  });
  const oldestProfile = slot % 5 === 0;
  const chooseKeyword = !oldestProfile && slot % 3 === 0 && keywords.length > 0;
  const keyword = [...keywords].sort((a, b) => stamp(a.lastCheckedAt) - stamp(b.lastCheckedAt))[0];
  const keywordTarget = keyword && {
    kind: "keyword" as const, id: keyword.id,
    url: `https://www.linkedin.com/search/results/content/?keywords=${encodeURIComponent(keyword.value)}&sortBy=%22date_posted%22`,
  };
  if (chooseKeyword && keywordTarget) return keywordTarget;
  // A pending-author revisit replaces only an already-planned profile hop.
  // The fifth slot still belongs to the longest-waiting watched profile.
  if (pending.length > 0 && (!eligible.length || (!oldestProfile && slot % 2 === 0))) {
    const selected = [...pending].sort((a, b) =>
      stamp(a.lastCheckedAt) - stamp(b.lastCheckedAt) ||
      stamp(b.latestPendingAt) - stamp(a.latestPendingAt) ||
      a.publicId.localeCompare(b.publicId))[0]!;
    return {
      kind: "profile", id: selected.publicId, source: "pending",
      url: `https://www.linkedin.com/in/${encodeURIComponent(selected.publicId)}/recent-activity/all/`,
    };
  }
  if (eligible.length === 0) {
    return keywordTarget ?? null;
  }
  const selected = [...eligible].sort((a, b) => oldestProfile
    ? stamp(a.lastCheckedAt) - stamp(b.lastCheckedAt)
    : stamp(b.latestObservedPostAt) - stamp(a.latestObservedPostAt) || stamp(a.lastCheckedAt) - stamp(b.lastCheckedAt))[0];
  if (!selected?.publicId) return null;
  return {
    kind: "profile", id: selected.id,
    url: `https://www.linkedin.com/in/${encodeURIComponent(selected.publicId)}/recent-activity/all/`,
  };
}
