import type { Sql } from "postgres";
import type { TweetMetrics } from "@noelle/x-client";
import {
  listPublishedTweetsForMetrics,
  recordOwnPostMetrics,
  type OwnPostMetricInsert,
} from "../lib/own-post-metrics-db.js";

// content-metrics: measure the operator's OWN published X posts through the
// OFFICIAL X API (GET /2/tweets, public_metrics) and append an engagement
// snapshot per post — the numbers the Performance tab shows. It is the X-API
// twin of the Apify x-self-track sweep: same table (noelle.own_post_metrics),
// same append-only latest-per-tweet model, but this path also carries real
// IMPRESSIONS (views), which Apify cannot see, plus the slot_id attribution.
//
// It runs as a throttled interval sweep inside the content-publish worker, which
// already builds the write-token X API client per instance (a read costs no
// write budget). Draft-only agents never publish, so they have no own posts and
// this is a no-op for them.

/** The read surface this tick needs — a narrow slice of the X API write client. */
export interface TweetMetricsReader {
  getTweetMetrics(ids: string[]): Promise<TweetMetrics[]>;
}

export interface ContentMetricsDeps {
  sql: Sql;
  instanceId: string;
  orgId: string;
  /** Null when the instance has no connected X account — the sweep is skipped. */
  reader: TweetMetricsReader | null;
  /** How far back to keep re-measuring a published post. */
  windowDays: number;
  /** Max published posts to re-measure per sweep. */
  maxPosts: number;
  /** Optional observation clock; production uses the current time. */
  now?: Date;
  log?: { warn: (obj: Record<string, unknown>, msg: string) => void };
}

export interface ContentMetricsResult {
  postsConsidered: number;
  measured: number;
}

const MISSING_TARGET_COOLDOWN_MS = 15 * 60_000;
const MAX_CACHED_INSTANCES = 100;
const MAX_MISSING_TARGETS = 200;
interface MissingTarget { expires: number; skipNextSweep: boolean }
const missingTargets = new WeakMap<Sql, Map<string, Map<string, MissingTarget>>>();

function instanceMissingTargets(sql: Sql, instanceId: string, now: number): Map<string, MissingTarget> {
  const instances = missingTargets.get(sql) ?? new Map<string, Map<string, MissingTarget>>();
  missingTargets.set(sql, instances);
  const missing = instances.get(instanceId) ?? new Map<string, MissingTarget>();
  for (const [id, target] of missing) if (target.expires <= now && !target.skipNextSweep) missing.delete(id);
  instances.delete(instanceId);
  instances.set(instanceId, missing);
  while (instances.size > MAX_CACHED_INSTANCES) instances.delete(instances.keys().next().value!);
  return missing;
}

/**
 * Re-measure own posts once for one instance:
 *   1. list the operator's published posts (slots + manual drafts) by tweet id;
 *   2. look their engagement up in one/few GET /2/tweets calls;
 *   3. append a snapshot per post X returned (with real impressions).
 * A post X didn't return this run (deleted / protected) is simply absent — never
 * recorded as zero. A transport/auth error drops the whole sweep (retried next
 * interval); the publish path is untouched.
 */
export async function runContentMetricsTick(deps: ContentMetricsDeps): Promise<ContentMetricsResult> {
  if (!deps.reader) return { postsConsidered: 0, measured: 0 };
  const requestedNow = deps.now?.getTime() ?? Date.now();
  const now = Number.isFinite(requestedNow) ? requestedNow : Date.now();
  const missing = instanceMissingTargets(deps.sql, deps.instanceId, now);

  const posts = await listPublishedTweetsForMetrics(deps.sql, {
    instanceId: deps.instanceId,
    windowDays: deps.windowDays,
    limit: deps.maxPosts,
    excludeTweetIds: [...missing.keys()],
  });
  // A long metrics cadence still gets one sweep past each omitted target.
  for (const target of missing.values()) target.skipNextSweep = false;
  if (posts.length === 0) return { postsConsidered: 0, measured: 0 };

  const byId = new Map(posts.map((p) => [p.tweetId, p]));
  let metrics: TweetMetrics[];
  try {
    metrics = await deps.reader.getTweetMetrics(posts.map((p) => p.tweetId));
  } catch (err) {
    deps.log?.warn({ instance: deps.instanceId, err: (err as Error).message }, "content-metrics: tweet lookup failed");
    return { postsConsidered: posts.length, measured: 0 };
  }

  const inserts: OwnPostMetricInsert[] = [];
  for (const m of metrics) {
    const p = byId.get(m.id);
    if (!p) continue;
    missing.delete(m.id);
    inserts.push({
      orgId: deps.orgId,
      instanceId: deps.instanceId,
      externalId: m.id,
      slotId: p.slotId,
      ideaId: p.ideaId,
      likes: m.likes,
      reposts: m.reposts,
      replies: m.replies,
      views: m.views,
      authorFollowerCount: null,
      quotes: m.quotes,
      bookmarks: m.bookmarks,
    });
  }

  const returnedIds = new Set(inserts.map((row) => row.externalId));
  for (const post of posts) {
    if (returnedIds.has(post.tweetId)) continue;
    missing.set(post.tweetId, { expires: now + MISSING_TARGET_COOLDOWN_MS, skipNextSweep: true });
    while (missing.size > MAX_MISSING_TARGETS) missing.delete(missing.keys().next().value!);
  }

  const measured = inserts.length ? await recordOwnPostMetrics(deps.sql, inserts) : 0;
  return { postsConsidered: posts.length, measured };
}
