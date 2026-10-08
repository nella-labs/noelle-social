import type { Sql } from "postgres";
import { VideoTeardownSchema, VideoUltraProfileSchema, type VideoUltraProfile } from "@noelle/contracts";
import type { TeardownWithMetrics, DistilledProfile } from "./distill.js";
import { readSourceCount, readSourceNonnegativeNumber } from "@noelle/runtime/source-values";
import { loadPrimaryVideoAccount } from "@noelle/runtime/video-account-db";

export interface DistillationSubject { platform: string; scope: "creator" | "account"; subject: string }
function ownSourceSql(sql: Sql) {
  return sql`exists (select 1 from noelle.video_watchlist_sources s
    where s.agent_instance_id=c.agent_instance_id and s.org_id=c.org_id
      and s.platform=c.platform and lower(btrim(s.handle))=lower(btrim(c.author_handle)) and s.is_own)`;
}

/** Each own platform is distilled once; watched creators retain exact platform/handle identity. */
export async function listDistillationSubjects(
  sql: Sql,
  instanceId: string,
): Promise<DistillationSubject[]> {
  const rows = await sql<DistillationSubject[]>`
    with candidates as (
      select c.platform,lower(btrim(c.author_handle)) as handle,
        ${ownSourceSql(sql)} as own
      from noelle.video_teardowns t
      join noelle.video_clips c on c.id=t.clip_id and c.org_id=t.org_id and c.agent_instance_id=t.agent_instance_id and c.platform=t.platform
      join noelle.agent_instances a on a.id=c.agent_instance_id and a.org_id=c.org_id
      where c.agent_instance_id=${instanceId} and c.source_kind in ('creator','account')
    )
    select distinct platform,case when own then 'account' else 'creator' end as scope,
      case when own then 'me' else handle end as subject from candidates
    order by platform,scope,subject
  `;
  return [...rows];
}

/** Teardowns for the exact subject; account targets aggregate declared own handles on one platform. */
export async function listTeardownsForSubject(
  sql: Sql,
  instanceId: string,
  target: DistillationSubject,
): Promise<TeardownWithMetrics[]> {
  const rows = await sql<Array<{ clip_id: string; teardown: unknown; views: string | null; likes: string | null; comments: string | null }>>`
    select t.clip_id, t.teardown, c.views::text,c.likes::text,c.comments::text
    from noelle.video_teardowns t
    join noelle.video_clips c on c.id=t.clip_id and c.org_id=t.org_id and c.agent_instance_id=t.agent_instance_id and c.platform=t.platform
    join noelle.agent_instances a on a.id=c.agent_instance_id and a.org_id=c.org_id
    where c.agent_instance_id=${instanceId} and c.platform=${target.platform} and c.source_kind in ('creator','account')
      and (${target.scope}='creator' and lower(btrim(c.author_handle))=${target.subject} and not ${ownSourceSql(sql)}
        or ${target.scope}='account' and ${ownSourceSql(sql)})
  `;
  const out: TeardownWithMetrics[] = [];
  for (const r of rows) {
    const parsed = VideoTeardownSchema.safeParse(r.teardown);
    if (!parsed.success) continue;
    out.push({
      clipId: r.clip_id,
      teardown: parsed.data,
      views: readSourceCount(r.views),
      likes: readSourceCount(r.likes),
      comments: readSourceCount(r.comments),
    });
  }
  return out;
}

export async function upsertUltraProfile(
  sql: Sql,
  args: {
    orgId: string;
    instanceId: string;
    platform: string;
    scope: "creator" | "niche" | "account";
    subject: string;
    distilled: DistilledProfile;
    model: string;
  },
): Promise<void> {
  const d = args.distilled;
  await sql`
    insert into noelle.video_ultra_profiles
      (org_id, agent_instance_id, platform, scope, subject, profile, avg_views, avg_likes,
       avg_comments, clips_analyzed, sample_clip_ids, model, generated_at, refreshed_at)
    values
      (${args.orgId}, ${args.instanceId}, ${args.platform}, ${args.scope}, ${args.subject},
       ${sql.json(d.profile as never)}, ${d.avgViews}, ${d.avgLikes}, ${d.avgComments},
       ${d.clipsAnalyzed}, ${d.sampleClipIds}, ${args.model}, now(), now())
    on conflict (agent_instance_id, platform, scope, subject) do update set
      profile = excluded.profile,
      avg_views = excluded.avg_views,
      avg_likes = excluded.avg_likes,
      avg_comments = excluded.avg_comments,
      clips_analyzed = excluded.clips_analyzed,
      sample_clip_ids = excluded.sample_clip_ids,
      model = excluded.model,
      refreshed_at = now()
  `;
}

/** The operator's OWN-account Brand Guide + its aggregate metrics. */
export interface AccountUltraProfile {
  profile: VideoUltraProfile;
  avgViews: number | null;
  avgLikes: number | null;
  avgComments: number | null;
  clipsAnalyzed: number;
}

/**
 * The primary own account platform's scope='account' ultra-profile,
 * distilled by the distiller as subject='me'. Deliberately NOT `loadUltraProfiles`
 * — that orders by clips_analyzed desc + limits N, so a 1-clip account row can be
 * dropped behind heavier creator rows. Here we want the account row specifically.
 * Returns null when there's no account profile yet, or its jsonb fails the schema
 * (fail-open: the caller then omits the "what performs" section).
 */
export async function loadAccountUltraProfile(
  sql: Sql,
  instanceId: string,
): Promise<AccountUltraProfile | null> {
  const account = await loadPrimaryVideoAccount(sql, instanceId);
  if (!account) return null;
  const rows = await sql<
    Array<{
      profile: unknown;
      avg_views: string | null;
      avg_likes: string | null;
      avg_comments: string | null;
      clips_analyzed: number;
    }>
  >`
    select profile, avg_views, avg_likes, avg_comments, clips_analyzed
    from noelle.video_ultra_profiles p
    join noelle.agent_instances a on a.id=p.agent_instance_id and a.org_id=p.org_id
    where p.agent_instance_id=${instanceId} and p.org_id=${account.orgId} and p.platform=${account.platform}
      and scope='account' and subject='me'
    limit 1`;
  const r = rows[0];
  if (!r) return null;
  const parsed = VideoUltraProfileSchema.safeParse(r.profile);
  if (!parsed.success) return null;
  return {
    profile: parsed.data,
    avgViews: readSourceNonnegativeNumber(r.avg_views),
    avgLikes: readSourceNonnegativeNumber(r.avg_likes),
    avgComments: readSourceNonnegativeNumber(r.avg_comments),
    clipsAnalyzed: r.clips_analyzed,
  };
}

/** Clips missing a dense embedding (caption+transcript text), for the Voyage backfill. */
export async function listUnembeddedClips(
  sql: Sql,
  instanceId: string,
  limit: number,
): Promise<Array<{ id: string; text: string }>> {
  const rows = await sql<Array<{ id: string; caption: string; transcript: string | null }>>`
    select c.id, c.caption, t.transcript
    from noelle.video_clips c
    left join noelle.video_teardowns t on t.clip_id = c.id
    where c.agent_instance_id = ${instanceId} and c.embedding is null
    order by case when c.views between 0 and ${Number.MAX_SAFE_INTEGER} then c.views end desc nulls last
    limit ${limit}
  `;
  return rows
    .map((r) => ({ id: r.id, text: `${r.caption ?? ""}\n${r.transcript ?? ""}`.trim() }))
    .filter((r) => r.text.length > 0);
}

export async function writeClipEmbeddings(
  sql: Sql,
  rows: Array<{ id: string; embedding: number[] }>,
): Promise<void> {
  for (const r of rows) {
    if (!r.embedding.length) continue;
    const vec = `[${r.embedding.join(",")}]`;
    await sql`update noelle.video_clips set embedding = ${vec}::vector where id = ${r.id}`;
  }
}
