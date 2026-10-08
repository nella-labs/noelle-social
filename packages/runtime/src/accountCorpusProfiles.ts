import type { JSONValue, Sql } from "postgres";
import type { UltraProfileRow } from "./styleTypes.js";

export interface AccountUltraProfileUpsert {
  orgId: string; agentInstanceId: string; platform: string; accountHandle: string;
  voiceSummary: string; tone: string; structureNotes: string;
  hookPatterns: string[]; signaturePhrases: string[]; topTopics: string[];
  avgLikeCount: number | null; avgCommentCount: number | null; postsAnalyzed: number;
  /** Measured source IDs used for the performance sample. */
  samplePostIds: string[];
  model: string;
}

/** Refresh only a coherent, locked parent; averages retain unknown measurements. */
export async function upsertAccountUltraProfile(sql: Sql, p: AccountUltraProfileUpsert): Promise<void> {
  await sql`
    with owner as materialized (
      select id,org_id from noelle.agent_instances
      where id=${p.agentInstanceId} and org_id=${p.orgId} for share
    )
    insert into noelle.account_ultra_profiles
      (org_id,agent_instance_id,platform,account_handle,voice_summary,tone,structure_notes,
       hook_patterns,signature_phrases,top_topics,avg_like_count,avg_comment_count,
       posts_analyzed,sample_post_ids,model,generated_at,refreshed_at)
    select org_id,id,${p.platform},${p.accountHandle},${p.voiceSummary},${p.tone},${p.structureNotes},
      ${sql.json(p.hookPatterns as unknown as JSONValue)},${sql.json(p.signaturePhrases as unknown as JSONValue)},
      ${sql.json(p.topTopics as unknown as JSONValue)},${p.avgLikeCount},${p.avgCommentCount},
      ${p.postsAnalyzed},${p.samplePostIds},${p.model},now(),now() from owner
    on conflict (agent_instance_id,platform,account_handle) do update set
      voice_summary=excluded.voice_summary,tone=excluded.tone,structure_notes=excluded.structure_notes,
      hook_patterns=excluded.hook_patterns,signature_phrases=excluded.signature_phrases,
      top_topics=excluded.top_topics,avg_like_count=excluded.avg_like_count,
      avg_comment_count=excluded.avg_comment_count,posts_analyzed=excluded.posts_analyzed,
      sample_post_ids=excluded.sample_post_ids,model=excluded.model,
      generated_at=excluded.generated_at,refreshed_at=excluded.refreshed_at
    where account_ultra_profiles.org_id=excluded.org_id`;
}

interface StoredProfile {
  account_handle: string; voice_summary: string | null; tone: string | null; structure_notes: string | null;
  hook_patterns: unknown; signature_phrases: unknown; top_topics: unknown;
}
function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}
function normalize(row: StoredProfile): UltraProfileRow {
  return { ...row, hook_patterns: stringList(row.hook_patterns),
    signature_phrases: stringList(row.signature_phrases), top_topics: stringList(row.top_topics) };
}

/** Automatic style notes require a coherent current owner and matching enabled source. */
export async function listUltraProfiles(sql: Sql, args: {
  agentInstanceId: string; platform: string;
}): Promise<UltraProfileRow[]> {
  const rows = await sql<StoredProfile[]>`
    select p.account_handle,p.voice_summary,p.tone,p.structure_notes,
      p.hook_patterns,p.signature_phrases,p.top_topics
    from noelle.account_ultra_profiles p
    join noelle.agent_instances a on a.id=p.agent_instance_id and a.org_id=p.org_id
    where p.agent_instance_id=${args.agentInstanceId} and p.platform=${args.platform}
      and exists (select 1 from noelle.account_feeder_sources s
        where s.agent_instance_id=p.agent_instance_id and s.org_id=p.org_id
          and s.platform=p.platform and lower(s.handle)=lower(p.account_handle) and s.enabled=true)
    order by p.refreshed_at desc nulls last,p.generated_at desc nulls last`;
  return rows.map(normalize);
}

/** A pinned profile is enabled-independent and case-insensitive, but owner-coherent. */
export async function getUltraProfileForHandle(sql: Sql, args: {
  agentInstanceId: string; platform: string; handle: string;
}): Promise<UltraProfileRow | null> {
  const rows = await sql<StoredProfile[]>`
    select p.account_handle,p.voice_summary,p.tone,p.structure_notes,
      p.hook_patterns,p.signature_phrases,p.top_topics
    from noelle.account_ultra_profiles p
    join noelle.agent_instances a on a.id=p.agent_instance_id and a.org_id=p.org_id
    where p.agent_instance_id=${args.agentInstanceId} and p.platform=${args.platform}
      and lower(p.account_handle)=lower(${args.handle})
    order by p.refreshed_at desc nulls last,p.generated_at desc nulls last limit 1`;
  return rows[0] ? normalize(rows[0]) : null;
}
