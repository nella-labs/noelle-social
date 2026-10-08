import type { Sql } from "postgres";
import type { SpendRow } from "@noelle/runtime";
import { withMeteredApifyCall } from "@noelle/runtime/apify-metering";
import { readSourceCount } from "@noelle/runtime/source-values";
import { defaultVideoApifyActor } from "../lib/apify-rotating.js";
import type { ApifyHandle } from "../lib/apify-resolver.js";
import type { Logger } from "../lib/logger.js";
import { listDueOwnSources, recordClipMetricsSnapshot } from "../lib/self-tracking-db.js";
import { markSourcePulled } from "../lib/watchlist-db.js";
import { upsertVideoClips } from "../lib/video-clips-db.js";


export interface SelfTrackTickDeps {
  sql: Sql;
  log: Logger;
  resolveApify: (orgId: string) => Promise<ApifyHandle | null>;
  recorder: { record: (row: SpendRow) => Promise<unknown> };
  /** Sources pulled before this instant are due. */
  dueBefore: Date;
  /** How many of the operator's own posts to pull per refresh. */
  maxPosts: number;
  /** How far back to look for the operator's posts. */
  windowDays: number;
}

/**
 * 24/7 own-account tracking. For each due is_own source, pull the operator's own
 * posts (creatorReels — the proven posts path) + their follower count
 * (accountSnapshot), upsert as source_kind='account' clips, and append a
 * video_clip_metrics snapshot so the analytics page can chart performance + the
 * follower trend over time. Per-source failures are isolated (logged, skipped).
 * Returns the number of metric snapshots written.
 */
export async function runSelfTrackTick(deps: SelfTrackTickDeps): Promise<number> {
  const { sql, log, resolveApify, recorder } = deps;
  const due = await listDueOwnSources(sql, deps.dueBefore);
  if (due.length === 0) return 0;

  const sinceISO = new Date(Date.now() - deps.windowDays * 86_400_000).toISOString();
  let snapshots = 0;

  for (const src of due) {
    try {
      const handle = await resolveApify(src.orgId);
      if (!handle) {
        log.warn({ instance: src.instanceId, handle: src.handle }, "no apify token; skipping self-track");
        continue;
      }

      // Follower count (for the trend + the reach-multiple denominator).
      const snap = await withMeteredApifyCall({ client: handle.client, recorder, log,
        orgId: src.orgId, instanceId: src.instanceId, agentRole: "video_intern", worker: "harvester",
        actor: defaultVideoApifyActor(src.platform), startedAt: new Date(), credentialId: handle.credentialId },
        operation => operation.accountSnapshot({ platform: src.platform, handle: src.handle })).catch(() => null);
      const followerCount = readSourceCount(snap?.followerCount);

      const pulled = await withMeteredApifyCall({ client: handle.client, recorder, log,
        orgId: src.orgId, instanceId: src.instanceId, agentRole: "video_intern", worker: "harvester",
        actor: defaultVideoApifyActor(src.platform), startedAt: new Date(), credentialId: handle.credentialId },
        operation => operation.creatorReels({ platform: src.platform, handle: src.handle,
          maxItems: deps.maxPosts, sinceISO }));

      const clips = followerCount != null ? pulled.map((c) => ({ ...c, authorFollowerCount: followerCount })) : pulled;
      await upsertVideoClips(sql, { orgId: src.orgId, instanceId: src.instanceId, sourceKind: "account", clips });
      const n = await recordClipMetricsSnapshot(sql, {
        orgId: src.orgId,
        instanceId: src.instanceId,
        platform: src.platform,
        clips,
        followerCount,
      });
      snapshots += n;
      await markSourcePulled(sql, src.id, followerCount);
      log.info(
        { instance: src.instanceId, handle: src.handle, followers: followerCount, posts: clips.length, snapshots: n },
        "own account tracked",
      );
    } catch (err) {
      log.error({ err: (err as Error).message, instance: src.instanceId, handle: src.handle }, "self-track failed");
    }
  }
  return snapshots;
}
