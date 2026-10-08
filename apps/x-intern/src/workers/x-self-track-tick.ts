import type { Sql } from "postgres";
import type { XTweet } from "@noelle/x-apify";
import {
  listOwnPublishedPosts,
  recordOwnPostMetrics,
  type OwnPostMetricInsert,
} from "../lib/own-post-metrics-db.js";

// x-self-track: measure the operator's OWN published X posts and append an
// engagement snapshot per post, attributed to the idea that produced it. This
// is the capture half of the learn loop; the X ideation worker consumes the
// rollup. It runs as an interval sweep inside the ideation worker (which is
// always alive and already resolves Apify) — the interns are draft-only, so
// there's no dedicated posting worker to hang it off.
//
// Read path is Apify (userTweets by handle) — no X login, no ban risk, and no
// connected account needed (the handle is parsed from the post URL). Apify
// returns likes/reposts/replies but NOT views/bookmarks (only the official X
// API exposes impressions), so views is recorded null.

/** The Apify read surface this tick needs (a narrow slice of the pool client). */
export interface OwnPostReader {
  userTweets(args: { handle: string; limit?: number }): Promise<{ tweets: XTweet[] }>;
}

export interface XSelfTrackDeps {
  sql: Sql;
  instanceId: string;
  orgId: string;
  reader: OwnPostReader;
  windowDays: number;
  /** Max own posts to consider + max own tweets to pull per handle. */
  maxPosts: number;
  log?: { warn: (obj: Record<string, unknown>, msg: string) => void };
}

export interface XSelfTrackResult {
  postsConsidered: number;
  measured: number;
}

/**
 * Measure own posts once for one instance:
 *   1. list the operator's published posts (autonomous slots + manual drafts);
 *   2. group them by author handle, pull that handle's recent tweets from Apify;
 *   3. for each post whose tweet we found, append an engagement snapshot.
 * A post whose tweet Apify didn't return this run is skipped (retried next
 * sweep) — never recorded as zero engagement. Per-handle failures are isolated.
 */
export async function runXSelfTrackTick(deps: XSelfTrackDeps): Promise<XSelfTrackResult> {
  const posts = await listOwnPublishedPosts(deps.sql, {
    instanceId: deps.instanceId,
    windowDays: deps.windowDays,
    limit: deps.maxPosts,
  });
  if (posts.length === 0) return { postsConsidered: 0, measured: 0 };

  const byHandle = new Map<string, typeof posts>();
  for (const p of posts) {
    const g = byHandle.get(p.handle);
    if (g) g.push(p);
    else byHandle.set(p.handle, [p]);
  }

  const inserts: OwnPostMetricInsert[] = [];
  for (const [handle, group] of byHandle) {
    let tweets: XTweet[];
    try {
      tweets = (await deps.reader.userTweets({ handle, limit: deps.maxPosts })).tweets;
    } catch (err) {
      deps.log?.warn({ handle, err: (err as Error).message }, "x-self-track: own tweets fetch failed");
      continue;
    }
    const byId = new Map<string, XTweet>();
    let followers: number | null = null;
    for (const t of tweets) {
      byId.set(String(t.id), t);
      if (followers == null && t.author?.followers != null) followers = t.author.followers;
    }
    for (const p of group) {
      const t = byId.get(p.tweetId);
      if (!t) continue; // not in this pull — retry next sweep, never record a 0
      inserts.push({
        orgId: deps.orgId,
        instanceId: deps.instanceId,
        externalId: p.tweetId,
        slotId: null,
        ideaId: p.ideaId,
        likes: t.likes ?? 0,
        reposts: t.reposts ?? 0,
        replies: t.replies ?? 0,
        views: null,
        authorFollowerCount: t.author?.followers ?? followers,
      });
    }
  }

  const measured = inserts.length ? await recordOwnPostMetrics(deps.sql, inserts) : 0;
  return { postsConsidered: posts.length, measured };
}
