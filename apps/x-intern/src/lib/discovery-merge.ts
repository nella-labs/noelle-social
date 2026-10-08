import type { XTweet } from "@noelle/x-apify";

/** Give each fetched source one turn, retaining one observation per post ID. */
export function mergeDiscoveryTweets(batches: readonly (readonly XTweet[])[]): XTweet[] {
  const merged: XTweet[] = [];
  const seen = new Set<string>();
  const longest = batches.reduce((length, batch) => Math.max(length, batch.length), 0);
  for (let index = 0; index < longest; index++) {
    for (const batch of batches) {
      const tweet = batch[index];
      if (!tweet || seen.has(tweet.id)) continue;
      seen.add(tweet.id);
      merged.push(tweet);
    }
  }
  return merged;
}
