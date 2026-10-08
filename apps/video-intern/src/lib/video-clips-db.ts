import type { JSONValue, Sql } from "postgres";
import type { VideoClip } from "@noelle/video-apify";
import { readSourceCount, readSourceNonnegativeNumber, readSourceTimestamp } from "@noelle/runtime/source-values";
import { withVideoDb, withVideoOwner } from "./video-owner-db.js";

/**
 * Upsert harvested clips into noelle.video_clips. Composite conflict key
 * (agent_instance_id, platform, external_id) with metric REFRESH on conflict —
 * re-harvesting a creator updates climbing view/like counts without dupes
 * (mirrors the account feeder's upsertStylePosts, NOT the leads DO-NOTHING).
 * Returns the number of rows written (inserted + updated).
 */
export async function upsertVideoClips(
  sql: Sql,
  args: { orgId: string; instanceId: string; sourceKind: "creator" | "niche" | "account"; clips: VideoClip[] },
): Promise<number> {
  if (args.clips.length === 0) return 0;
  const values = args.clips.map((c) => ({
    org_id: args.orgId,
    agent_instance_id: args.instanceId,
    platform: c.platform,
    external_id: c.id,
    source_kind: args.sourceKind,
    author_handle: c.authorHandle,
    caption: c.caption,
    url: c.url,
    video_url: c.videoUrl,
    thumb_url: c.thumbUrl,
    views: readSourceCount(c.views),
    likes: readSourceCount(c.likes),
    comments: readSourceCount(c.comments),
    shares: readSourceCount(c.shares),
    saves: readSourceCount(c.saves),
    duration_s: readSourceNonnegativeNumber(c.durationSec),
    music_id: c.musicId,
    music_name: c.musicName,
    author_follower_count: readSourceCount(c.authorFollowerCount),
    raw: c.raw ?? {},
    posted_at: readSourceTimestamp(c.postedAt),
  }));
  return withVideoOwner(sql, args.instanceId, args.orgId, async tx => {
    const rows = await tx<{ id: string }[]>`
    with incoming as (
      select * from jsonb_to_recordset(${tx.json(values as unknown as JSONValue)}) as i(
        org_id uuid,agent_instance_id uuid,platform text,external_id text,source_kind text,author_handle text,
        caption text,url text,video_url text,thumb_url text,views bigint,likes bigint,comments bigint,
        shares bigint,saves bigint,duration_s numeric,music_id text,music_name text,
        author_follower_count bigint,raw jsonb,posted_at timestamptz)
    )
    insert into noelle.video_clips
      (org_id,agent_instance_id,platform,external_id,source_kind,author_handle,
       caption,url,video_url,thumb_url,views,likes,comments,shares,saves,
       duration_s,music_id,music_name,author_follower_count,raw,posted_at)
    select i.* from incoming i
    on conflict (agent_instance_id, platform, external_id) do update set
      source_kind = case when excluded.source_kind='account' then 'account' else video_clips.source_kind end,
      caption = excluded.caption,
      url = excluded.url,
      video_url = excluded.video_url,
      thumb_url = excluded.thumb_url,
      views = excluded.views,
      likes = excluded.likes,
      comments = excluded.comments,
      shares = excluded.shares,
      saves = excluded.saves,
      author_follower_count = excluded.author_follower_count,
      music_id = excluded.music_id,
      music_name = excluded.music_name,
      raw = excluded.raw,
      posted_at = coalesce(excluded.posted_at,video_clips.posted_at),
      pulled_at = now()
    where video_clips.org_id=excluded.org_id
    returning id`;
    return rows.length;
  }, 0);
}

/**
 * Flag the top view-percentile clips for the Phase-2 deep teardown pass. Clips at
 * or above `percentile` (0-100) of this instance's view distribution get
 * deep_tier=true; the rest get the cheap bulk pass. percentile>=100 = never flag.
 */
export async function flagDeepTier(sql: Sql, instanceId: string, percentile: number): Promise<void> {
  if (percentile >= 100) return;
  const frac = Math.min(1, Math.max(0, percentile / 100));
  await withVideoDb(sql, tx => tx`
    with owner as materialized (
      select id,org_id from noelle.agent_instances where id=${instanceId} for share
    ), ranked as (
      select c.id, percent_rank() over (order by c.views) as pr
      from noelle.video_clips c join owner a on a.id=c.agent_instance_id and a.org_id=c.org_id
      where c.views between 0 and ${Number.MAX_SAFE_INTEGER}
    )
    update noelle.video_clips v
    set deep_tier = coalesce((select r.pr >= ${frac} from ranked r where r.id=v.id),false)
    from owner a
    where a.id=v.agent_instance_id and a.org_id=v.org_id`);
}
