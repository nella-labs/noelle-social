import type { Bus } from "@noelle/runtime";
import type { OwnAccount } from "@noelle/x-client";
import type { XTweet } from "@noelle/x-apify";
import {
  writeOwnAccountSnapshot,
  readOwnAccountSnapshot,
  type OwnAccountSnapshot,
} from "../lib/own-account.js";

// own-account: refresh the operator's OWN account snapshot (handle + follower /
// following / post counts) onto the shared memory bus, so the drafter can state
// a real number instead of inventing one.
//
// TWO READ PATHS, IN THIS ORDER, AND THE ORDER IS THE WHOLE POINT:
//
//   1. The official X API (GET /2/users/me). One call, a read (no write budget),
//      and it works whether or not the operator published anything recently.
//      This is what the old x-self-track sweep could not do: that sweep only
//      ever saw a follower count riding along on a *published post*, so the
//      number went dark 30 days after the last post.
//   2. Apify (userTweets on the resolved handle), as a fallback for instances
//      with no connected X account. Kept deliberately second: the pool has been
//      fully exhausted since 2026-07-11 ("all 52 are exhausted or invalid"),
//      which is precisely why the follower count went stale in the first place.
//
// Failure is ALWAYS "leave the old snapshot alone", never "write a zero". A
// stale snapshot is handled downstream (renderOwnAccountBlock reports the count
// as unknown past OWN_ACCOUNT_MAX_AGE_DAYS); a zero would be repeated out loud.

/** The X API read surface this tick needs (a narrow slice of XWriteClient). */
export interface OwnAccountApiReader {
  getMyAccount(): Promise<OwnAccount>;
}

/** The Apify read surface this tick needs (a narrow slice of the pool client). */
export interface OwnAccountApifyReader {
  userTweets(args: { handle: string; limit?: number }): Promise<{ tweets: XTweet[] }>;
}

export interface OwnAccountTickDeps {
  bus: Bus;
  /** Official X API client, or null when the instance has no connected account. */
  api: OwnAccountApiReader | null;
  /**
   * Apify fallback, resolved LAZILY — it is only awaited if the X API path is
   * absent or fails. Resolving a token is real work against a pool that is
   * routinely exhausted, and the happy path never needs it.
   */
  apify: (() => Promise<OwnAccountApifyReader | null>) | null;
  /**
   * Handle to use for the Apify fallback (Apify cannot answer "who am I?").
   * Comes from the connected X account, else the last snapshot's handle.
   */
  fallbackHandle: string | null;
  now: Date;
  log?: { warn: (obj: Record<string, unknown>, msg: string) => void };
}

export interface OwnAccountTickResult {
  snapshot: OwnAccountSnapshot | null;
  /** Which path produced the snapshot, or why none did. */
  outcome: "x_api" | "apify" | "no_reader" | "failed";
}

export async function runOwnAccountTick(deps: OwnAccountTickDeps): Promise<OwnAccountTickResult> {
  const capturedAt = deps.now.toISOString();

  if (deps.api) {
    try {
      const me = await deps.api.getMyAccount();
      const snapshot: OwnAccountSnapshot = {
        handle: me.handle,
        followers: me.followers,
        following: me.following,
        posts: me.posts,
        capturedAt,
        source: "x_api",
      };
      await writeOwnAccountSnapshot(deps.bus, snapshot, "own-account");
      return { snapshot, outcome: "x_api" };
    } catch (err) {
      deps.log?.warn({ err: (err as Error).message }, "own-account: x api users/me failed, trying apify");
    }
  }

  // Apify fallback. It has no "who am I?" call, so it needs a handle: the
  // connected account's, else whatever the last good snapshot recorded (which
  // makes the handle self-healing once resolved even after the X token is gone).
  const handle =
    deps.fallbackHandle?.trim().replace(/^@/, "") ||
    (await readOwnAccountSnapshot(deps.bus))?.handle ||
    "";
  if (!deps.apify || !handle) return { snapshot: null, outcome: "no_reader" };

  try {
    const apify = await deps.apify();
    if (!apify) return { snapshot: null, outcome: "no_reader" };
    const { tweets } = await apify.userTweets({ handle, limit: 5 });
    // The follower count rides on the author of any returned tweet. An empty
    // pull, or a pull with no follower count on it, is UNKNOWN — not zero.
    let followers: number | null = null;
    for (const t of tweets) {
      if (t.author?.followers != null) {
        followers = t.author.followers;
        break;
      }
    }
    if (followers == null) return { snapshot: null, outcome: "failed" };
    const snapshot: OwnAccountSnapshot = {
      handle,
      followers,
      following: null,
      posts: null,
      capturedAt,
      source: "apify",
    };
    await writeOwnAccountSnapshot(deps.bus, snapshot, "own-account");
    return { snapshot, outcome: "apify" };
  } catch (err) {
    deps.log?.warn({ handle, err: (err as Error).message }, "own-account: apify fallback failed");
    return { snapshot: null, outcome: "failed" };
  }
}
