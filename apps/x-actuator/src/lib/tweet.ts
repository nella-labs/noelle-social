// Tweet-permalink parsing for the background worker. The X analog of the
// LinkedIn actuator's lib/urn.ts (activityUrnFrom): a queue item's url is the
// tweet permalink ("https://x.com/<handle>/status/<id>"), and stamping the
// parsed status id onto activity rows means a skip/failure names WHICH tweet
// it happened on without a live DevTools session.

/** The numeric status id parsed from a tweet permalink, or null. */
export function tweetIdFromUrl(url: string): string | null {
  return /\/status\/(\d+)/.exec(url)?.[1] ?? null;
}
