import type { ParameterOrFragment, RowList, Sql } from "postgres";
import { VideoPlatformSchema, VideoWatchlistSourceSchema } from "@noelle/contracts";
import { BoundedPgSession } from "./boundedPgSession.js";
import { readSourceCount, readSourceTimestamp } from "./sourceValues.js";

/** App readSql already owns its read-only lifecycle; native worker pools need a bounded session. */
export type VideoAccountQuery = <T extends readonly (object | undefined)[]>(
  template: TemplateStringsArray, ...parameters: readonly ParameterOrFragment<never>[]
) => Promise<RowList<T>>;
const sessions = new WeakMap<Sql, BoundedPgSession>();
export const VIDEO_FOLLOWER_SERIES_LIMIT = 720;
export interface PrimaryVideoAccount { id: string; orgId: string; instanceId: string; platform: "instagram" | "tiktok"; handle: string }
export interface VideoFollowerPoint { capturedAt: string; followerCount: number }
export interface VideoAccountTracking {
  account: PrimaryVideoAccount | null;
  followerCount: number | null;
  /** Complete measured history; null unless two distinct capture times exist. */
  followerDelta: number | null;
  /** Latest 720 captured-hour buckets; this bounded series does not define the delta window. */
  followerSeries: VideoFollowerPoint[];
}
interface StoredTracking {
  id: string; org_id: string; agent_instance_id: string; platform: string; handle: string;
  newest: string | null; oldest: string | null; captures: string; series: unknown;
}

async function readTracking(query: VideoAccountQuery, instanceId: string, followers: boolean): Promise<VideoAccountTracking> {
  const rows = await query<StoredTracking[]>`
    with account as materialized (
      select s.id,s.org_id,s.agent_instance_id,s.platform,lower(btrim(s.handle)) as handle
      from noelle.video_watchlist_sources s
      join noelle.agent_instances a on a.id=s.agent_instance_id and a.org_id=s.org_id
      where s.agent_instance_id=${instanceId} and s.is_own and s.enabled
        and s.platform in ('instagram','tiktok') and btrim(s.handle)<>''
      order by s.created_at asc,s.id asc limit 1
    ), captures as materialized (
      select m.captured_at,max(m.author_follower_count) as followers
      from account a
      join noelle.video_clips c on c.agent_instance_id=a.agent_instance_id and c.org_id=a.org_id
        and c.platform=a.platform and lower(btrim(c.author_handle))=a.handle
      join noelle.video_clip_metrics m on m.clip_id=c.id and m.agent_instance_id=c.agent_instance_id and m.org_id=c.org_id
      where ${followers} and m.author_follower_count between 0 and ${Number.MAX_SAFE_INTEGER}
      group by m.captured_at
    ), hours as (
      select date_trunc('hour',captured_at) as hour,max(followers) as followers from captures group by 1
      order by 1 desc limit ${VIDEO_FOLLOWER_SERIES_LIMIT}
    )
    select a.*,(select followers::text from captures order by captured_at desc limit 1) as newest,
      (select followers::text from captures order by captured_at asc limit 1) as oldest,
      (select count(*)::text from captures) as captures,
      coalesce((select jsonb_agg(jsonb_build_object('capturedAt',hour::text,'followerCount',followers::text) order by hour) from hours),'[]'::jsonb) as series
    from account a`;
  const row = rows[0];
  const platform = VideoPlatformSchema.safeParse(row?.platform);
  const handle = VideoWatchlistSourceSchema.shape.handle.safeParse(row?.handle);
  if (!row || !platform.success || !handle.success) return { account: null, followerCount: null, followerDelta: null, followerSeries: [] };
  const newest = readSourceCount(row.newest);
  const oldest = readSourceCount(row.oldest);
  const captures = readSourceCount(row.captures);
  const series = Array.isArray(row.series) ? row.series : [];
  return {
    account: { id: row.id, orgId: row.org_id, instanceId: row.agent_instance_id, platform: platform.data, handle: handle.data },
    followerCount: newest,
    followerDelta: captures !== null && captures >= 2 && newest !== null && oldest !== null ? newest - oldest : null,
    followerSeries: series.flatMap((point: unknown) => {
      if (!point || typeof point !== "object") return [];
      const value = point as Record<string, unknown>;
      const count = readSourceCount(value.followerCount);
      const capturedAt = readSourceTimestamp(value.capturedAt);
      return count === null || capturedAt === null ? [] : [{ capturedAt, followerCount: count }];
    }),
  };
}

/** One current primary tuple, chosen by the existing enabled oldest-source policy. */
export function loadVideoAccountTracking(query: VideoAccountQuery | Sql, instanceId: string, followers = true): Promise<VideoAccountTracking> {
  if (!("options" in query)) return readTracking(query, instanceId, followers);
  const native = query as Sql;
  let session = sessions.get(native);
  if (!session) {
    session = new BoundedPgSession(native, { deadlineMs: 8000, maxPending: 16, idleTimeoutMs: 1000 });
    sessions.set(native, session);
  }
  return session.run(sql => readTracking(sql, instanceId, followers));
}

export async function loadPrimaryVideoAccount(query: VideoAccountQuery | Sql, instanceId: string): Promise<PrimaryVideoAccount | null> {
  return (await loadVideoAccountTracking(query, instanceId, false)).account;
}
