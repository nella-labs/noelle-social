import type { Sql } from "postgres";
import type { VideoPlatform } from "@noelle/video-apify";

export interface VideoSourceRow {
  id: string;
  platform: VideoPlatform;
  handle: string;
}
export interface VideoNicheRow {
  id: string;
  platform: VideoPlatform;
  query: string;
}

export async function listEnabledSources(sql: Sql, instanceId: string): Promise<VideoSourceRow[]> {
  const rows = await sql<VideoSourceRow[]>`
    select id, platform, handle
    from noelle.video_watchlist_sources
    where agent_instance_id = ${instanceId} and enabled
    order by created_at asc`;
  return [...rows];
}

export async function listEnabledNiches(sql: Sql, instanceId: string): Promise<VideoNicheRow[]> {
  const rows = await sql<VideoNicheRow[]>`
    select id, platform, query
    from noelle.video_watchlist_niches
    where agent_instance_id = ${instanceId} and enabled
    order by created_at asc`;
  return [...rows];
}

/** Stamp last_pulled_at + refresh the follower snapshot (used as the outperformer denominator). */
export async function markSourcePulled(
  sql: Sql,
  id: string,
  followerCount: number | null,
): Promise<void> {
  await sql`
    update noelle.video_watchlist_sources
    set last_pulled_at = now(),
        follower_count = coalesce(${followerCount}, follower_count)
    where id = ${id}`;
}

export async function markNichePulled(sql: Sql, id: string): Promise<void> {
  await sql`update noelle.video_watchlist_niches set last_pulled_at = now() where id = ${id}`;
}
