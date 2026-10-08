import { parseRedditPermalink, readRedditThingId } from "@noelle/contracts";

/** Canonical thread identity from a supported permalink or complete post fullname. */
export function postIdFrom(url: string | null | undefined): string | null {
  if (!url) return null;
  if (url.trim().toLowerCase().startsWith("t3_")) return readRedditThingId(url, "post");
  return parseRedditPermalink(url)?.postId ?? null;
}

/** Keep the existing raw-URL fallback when a thread identity is unavailable. */
export function postDedupKey(url: string | null | undefined): string | null {
  if (!url) return null;
  const id = postIdFrom(url);
  return id ? `t3_${id}` : url;
}
