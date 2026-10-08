/**
 * Build a link to the original X post from a tweet id.
 *
 * The reliable tweet id is `leads.external_id` (the producer's `post_id` is
 * usually not synced — see payload-shapes.ts). x.com routes a status purely by
 * its numeric id, so the handle segment is cosmetic: when we don't know the
 * handle we use `i`, which redirects correctly.
 *
 * Returns null when there's no real tweet id to link to — a missing/empty id,
 * or a non-numeric one (e.g. the `synthetic-*` ids of seed leads).
 */
export function buildXPostUrl({
  handle,
  tweetId,
}: {
  handle?: string | null;
  tweetId?: string | null;
}): string | null {
  if (!tweetId || !/^\d+$/.test(tweetId)) return null;
  const h = handle?.replace(/^@/, "").trim();
  return `https://x.com/${h || "i"}/status/${tweetId}`;
}
