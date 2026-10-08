/**
 * Extract the tweet's numeric status id from a permalink, or null. Real X links
 * come in a few shapes — `x.com/<handle>/status/<id>`, the handle-less
 * `x.com/i/status/<id>`, plus `twitter.com`/`mobile.twitter.com` legacy hosts —
 * and ALL of them embed the id after `/status/`. (The X analog of the LinkedIn
 * actuator's activityUrnFrom; the id equals leads.external_id, which is what the
 * server-side dedup-by-link compares against.)
 */
export function tweetIdFrom(url: string | null | undefined): string | null {
  if (!url) return null;
  const m = url.match(/\/status(?:es)?\/(\d+)/i);
  return m?.[1] ?? null;
}

/**
 * The per-tweet dedup key: the numeric status id when derivable, else the raw
 * URL. Used by the in-session guard (RunState.actionedUrls) so two drafts for
 * one tweet (even with cosmetically different URL strings — x.com vs
 * twitter.com, trailing query params) collapse to the same key.
 */
export function tweetDedupKey(url: string | null | undefined): string | null {
  if (!url) return null;
  return tweetIdFrom(url) ?? url;
}
