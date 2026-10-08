import { parseRedditPermalink } from "@noelle/contracts";

/** The same thread identity used for successful replies and skip activity. */
export function postIdFromUrl(url: string): string | undefined {
  return parseRedditPermalink(url)?.postId;
}
