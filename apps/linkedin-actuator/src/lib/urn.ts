/**
 * Extract the canonical LinkedIn activity URN (`urn:li:activity:<id>`) from a post
 * URL, or null. Real LinkedIn links embed the numeric activity id in one of three
 * shapes — `...-activity-<id>-<code>`, `.../posts/activity-<id>-<code>`, and the
 * rare `urn:li:activity:<id>` — so match `activity[-:]<digits>` and normalize.
 * Kept byte-identical to the api-vm's activityUrnFrom so the extension's dedup key
 * (and the URN it stamps onto the activity log) matches what the queue compares
 * against server-side; the id equals leads.external_id.
 */
export function activityUrnFrom(url: string | null | undefined): string | null {
  if (!url) return null;
  const m = url.match(/activity[-:](\d+)/i);
  return m ? `urn:li:activity:${m[1]}` : null;
}

/**
 * The per-post dedup key: the activity URN when derivable, else the raw URL. Used
 * by the in-session guard so two drafts for one post (even with slightly different
 * URL strings) collapse to the same key.
 */
export function postDedupKey(url: string | null | undefined): string | null {
  if (!url) return null;
  return activityUrnFrom(url) ?? url;
}

/** Strict identity for a direct LinkedIn post URL; never trust cited or redirect URLs. */
export function directActivityUrn(raw: string): string | undefined {
  try {
    const url = new URL(raw, "https://www.linkedin.com");
    if (url.protocol !== "https:" || !["www.linkedin.com", "linkedin.com"].includes(url.hostname)) return undefined;
    if (url.username || url.password || /%(?:2f|5c)/i.test(url.pathname)) return undefined;
    const path = decodeURIComponent(url.pathname);
    const id = /^\/feed\/update\/urn:li:activity:(\d{10,})\/?$/i.exec(path)?.[1]
      ?? /^\/posts\/[^/]+-activity-(\d{10,})(?:-[^/]+)?\/?$/i.exec(path)?.[1];
    return id ? `urn:li:activity:${id}` : undefined;
  } catch { return undefined; }
}

/** One exact LinkedIn post short link; its token is never an activity ID. */
export function directShortPostUrl(raw: string): string | undefined {
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" || url.hostname !== "lnkd.in" || url.port ||
        url.username || url.password || url.search || url.hash) return undefined;
    const token = /^\/p\/([A-Za-z0-9_-]{1,128})\/?$/.exec(url.pathname)?.[1];
    return token ? `https://lnkd.in/p/${token}` : undefined;
  } catch { return undefined; }
}
