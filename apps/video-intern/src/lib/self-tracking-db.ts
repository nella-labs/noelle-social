import type { JSONValue, Sql } from "postgres";
import type { VideoPlatform, VideoClip } from "@noelle/video-apify";
import { readSourceCount, readSourceNonnegativeNumber } from "@noelle/runtime/source-values";
import { loadVideoAccountTracking, type PrimaryVideoAccount } from "@noelle/runtime/video-account-db";

// Data helpers for Nova self-tracking: the operator's own-account sources and
// the per-pull performance snapshots that feed the analytics page.

export interface OwnSourceRow {
  id: string;
  orgId: string;
  instanceId: string;
  platform: VideoPlatform;
  handle: string;
}

/**
 * Own-account sources (is_own) due for a refresh — never pulled, or last pulled
 * before `dueBefore`. Tracked 24/7 regardless of whether the instance is paused
 * (the operator's own performance keeps mattering), so no active-state filter.
 */
export async function listDueOwnSources(sql: Sql, dueBefore: Date): Promise<OwnSourceRow[]> {
  const rows = await sql<
    { id: string; org_id: string; agent_instance_id: string; platform: VideoPlatform; handle: string }[]
  >`
    select id, org_id, agent_instance_id, platform, handle
    from noelle.video_watchlist_sources
    where is_own and enabled
      and (last_pulled_at is null or last_pulled_at < ${dueBefore})
    order by last_pulled_at asc nulls first`;
  return rows.map((r) => ({
    id: r.id,
    orgId: r.org_id,
    instanceId: r.agent_instance_id,
    platform: r.platform,
    handle: r.handle,
  }));
}

/**
 * Append a performance snapshot for each just-pulled own-account clip. Resolves
 * the clip row ids by (instance, platform, external_id) — the clips were already
 * upserted — then inserts one video_clip_metrics row per clip with the current
 * counters + the account follower count at capture time. Returns rows written.
 */
export async function recordClipMetricsSnapshot(
  sql: Sql,
  args: {
    orgId: string;
    instanceId: string;
    platform: VideoPlatform;
    clips: VideoClip[];
    followerCount: number | null;
  },
): Promise<number> {
  if (args.clips.length === 0) return 0;
  const values = args.clips.filter(c => c.platform === args.platform).map(c => ({
    external_id: c.id, views: readSourceCount(c.views), likes: readSourceCount(c.likes),
    comments: readSourceCount(c.comments), shares: readSourceCount(c.shares), saves: readSourceCount(c.saves),
  }));
  if (values.length === 0) return 0;
  const written = await sql<{ id: string }[]>`
    with owner as materialized (
      select id,org_id from noelle.agent_instances
      where id=${args.instanceId} and org_id=${args.orgId} for share
    ), incoming as (
      select * from jsonb_to_recordset(${sql.json(values as unknown as JSONValue)}) as i(
        external_id text,views bigint,likes bigint,comments bigint,shares bigint,saves bigint)
    ), clips as materialized (
      select c.id,c.org_id,c.agent_instance_id,i.views,i.likes,i.comments,i.shares,i.saves
      from noelle.video_clips c join owner a on a.id=c.agent_instance_id and a.org_id=c.org_id
      join incoming i on i.external_id=c.external_id
      where c.platform=${args.platform} for share of c
    )
    insert into noelle.video_clip_metrics
      (org_id,agent_instance_id,clip_id,views,likes,comments,shares,saves,author_follower_count)
    select org_id,agent_instance_id,id,views,likes,comments,shares,saves,${readSourceCount(args.followerCount)}
    from clips returning id`;
  return written.length;
}

/** Rolled-up self-tracking numbers for the personal-brand-state "My numbers" section. */
export interface SelfMetricsSummary {
  /** Own clips with at least one performance snapshot. */
  clips: number;
  avgViews: number | null;
  avgLikes: number | null;
  avgComments: number | null;
  avgShares: number | null;
  avgSaves: number | null;
  /** Newest tracked follower count, or null when none was ever captured. */
  followerCount: number | null;
  /** Newest-minus-oldest follower count across the tracked window (null if <2 captures). */
  followerDelta: number | null;
  /** Account identity for the selected follower measurements; averages remain operator-wide. */
  followerHandle?: string | null;
  followerPlatform?: PrimaryVideoAccount["platform"] | null;
}

/**
 * Aggregate the operator's own-account performance from `video_clip_metrics`:
 * average the LATEST snapshot per clip (each clip is re-pulled over time, so we
 * take one row per clip — its most recent). Follower endpoints belong only to the
 * selected primary own account across its complete measured window. Returns null when nothing has been tracked yet,
 * so the composer omits the "My numbers" section. Read-only; no writes.
 */
export async function summarizeSelfMetrics(
  sql: Sql,
  instanceId: string,
): Promise<SelfMetricsSummary | null> {
  const rows = await sql<
    Array<{
      clips: number;
      avg_views: string | null;
      avg_likes: string | null;
      avg_comments: string | null;
      avg_shares: string | null;
      avg_saves: string | null;
    }>
  >`
    with coherent as (
      select m.* from noelle.video_clip_metrics m
      join noelle.video_clips c on c.id=m.clip_id and c.agent_instance_id=m.agent_instance_id and c.org_id=m.org_id
      join noelle.agent_instances a on a.id=m.agent_instance_id and a.org_id=m.org_id
      where m.agent_instance_id=${instanceId}
    ), latest as (
      select distinct on (clip_id)
        clip_id, views, likes, comments, shares, saves
      from coherent
      order by clip_id, captured_at desc
    )
    select
      count(*)::int as clips,
      avg(case when views between 0 and ${Number.MAX_SAFE_INTEGER} then views end)::text as avg_views,
      avg(case when likes between 0 and ${Number.MAX_SAFE_INTEGER} then likes end)::text as avg_likes,
      avg(case when comments between 0 and ${Number.MAX_SAFE_INTEGER} then comments end)::text as avg_comments,
      avg(case when shares between 0 and ${Number.MAX_SAFE_INTEGER} then shares end)::text as avg_shares,
      avg(case when saves between 0 and ${Number.MAX_SAFE_INTEGER} then saves end)::text as avg_saves
    from latest`;
  const r = rows[0];
  if (!r || r.clips === 0) return null;
  const tracking = await loadVideoAccountTracking(sql, instanceId);
  return {
    clips: r.clips,
    avgViews: readSourceNonnegativeNumber(r.avg_views),
    avgLikes: readSourceNonnegativeNumber(r.avg_likes),
    avgComments: readSourceNonnegativeNumber(r.avg_comments),
    avgShares: readSourceNonnegativeNumber(r.avg_shares),
    avgSaves: readSourceNonnegativeNumber(r.avg_saves),
    followerCount: tracking.followerCount,
    followerDelta: tracking.followerDelta,
    followerHandle: tracking.account?.handle ?? null,
    followerPlatform: tracking.account?.platform ?? null,
  };
}
