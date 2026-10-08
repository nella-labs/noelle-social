import type { JSONValue, Sql } from "postgres";
import { readSourceCount, readSourceTimestamp } from "./sourceValues.js";
import { corpusEngagementSql } from "./accountCorpusMetrics.js";
export { computePerfRollup, corpusEngagement, corpusEngagementSql } from "./accountCorpusMetrics.js";
export { listStyleExemplars, listStyleExemplarsForHandle, parsePgVector } from "./accountCorpusExemplars.js";
export { upsertAccountUltraProfile, type AccountUltraProfileUpsert } from "./accountCorpusProfiles.js";
export { listUltraProfiles, getUltraProfileForHandle } from "./accountCorpusProfiles.js";
export { listEnabledFeederSources, listFeederSources, type FeederSource } from "./accountFeederSources.js";

export interface StylePostUpsert {
  orgId: string; agentInstanceId: string; platform: string; accountHandle: string;
  externalId: string; kind: "post" | "comment"; body: string;
  likeCount: number | null; commentCount: number | null; repostCount?: number | null;
  raw: unknown; postedAt?: string | null;
}
export interface CorpusItem {
  externalId: string; kind: "post" | "comment"; body: string;
  likeCount: number | null; commentCount: number | null; postedAt: string | null;
}
export interface UnembeddedStylePost { id: string; body: string }
export interface StylePostEmbedding { id: string; body: string; embedding: number[] }

/** Atomic owner-coherent corpus refresh; unknown birth dates retain known dates. */
export async function upsertStylePosts(sql: Sql, rows: StylePostUpsert[]): Promise<number> {
  if (!rows.length) return 0;
  const values = rows.map(row => ({ org_id: row.orgId, agent_instance_id: row.agentInstanceId,
    platform: row.platform, account_handle: row.accountHandle, external_id: row.externalId,
    kind: row.kind, body: row.body, like_count: readSourceCount(row.likeCount),
    comment_count: readSourceCount(row.commentCount), repost_count: readSourceCount(row.repostCount),
    raw: row.raw ?? {}, posted_at: readSourceTimestamp(row.postedAt) }));
  const written = await sql<{ id: string }[]>`
    with incoming as (select * from jsonb_to_recordset(${sql.json(values as unknown as JSONValue)}) as i(
      org_id uuid,agent_instance_id uuid,platform text,account_handle text,external_id text,
      kind text,body text,like_count bigint,comment_count bigint,repost_count bigint,raw jsonb,posted_at timestamptz)),
    owners as materialized (
      select a.id,a.org_id from noelle.agent_instances a
      where exists (select 1 from incoming i where i.agent_instance_id=a.id and i.org_id=a.org_id)
      for share of a
    )
    insert into noelle.account_style_posts
      (org_id,agent_instance_id,platform,account_handle,external_id,kind,body,
       like_count,comment_count,repost_count,raw,posted_at)
    select i.org_id,i.agent_instance_id,i.platform,i.account_handle,i.external_id,i.kind,i.body,
      i.like_count,i.comment_count,i.repost_count,i.raw,i.posted_at
    from incoming i join owners a on a.id=i.agent_instance_id and a.org_id=i.org_id
    on conflict (agent_instance_id,platform,external_id) do update set
      account_handle=excluded.account_handle,kind=excluded.kind,body=excluded.body,
      embedding=case when account_style_posts.body is distinct from excluded.body
        then null else account_style_posts.embedding end,
      like_count=excluded.like_count,comment_count=excluded.comment_count,repost_count=excluded.repost_count,
      raw=excluded.raw,posted_at=coalesce(excluded.posted_at,account_style_posts.posted_at),pulled_at=now()
    where account_style_posts.org_id=excluded.org_id
    returning id`;
  return written.length;
}

/** Known counts rank first; native legacy malformed counts are returned as unknown. */
export async function getAccountCorpus(sql: Sql, args: {
  agentInstanceId: string; platform: string; accountHandle: string; limit: number;
}): Promise<CorpusItem[]> {
  const rows = await sql<Array<{ external_id: string; kind: "post" | "comment"; body: string;
    like_count: string | null; comment_count: string | null; posted_at: string | null }>>`
    select p.external_id,p.kind,p.body,p.like_count::text,p.comment_count::text,p.posted_at::text
    from noelle.account_style_posts p
    join noelle.agent_instances a on a.id=p.agent_instance_id and a.org_id=p.org_id
    where p.agent_instance_id=${args.agentInstanceId} and p.platform=${args.platform}
      and p.account_handle=${args.accountHandle}
    order by case when p.like_count between 0 and ${Number.MAX_SAFE_INTEGER} then p.like_count end desc nulls last,
      p.posted_at desc nulls last,p.id
    limit ${args.limit}`;
  return rows.map(row => ({ externalId: row.external_id,kind: row.kind,body: row.body,
    likeCount: readSourceCount(row.like_count),commentCount: readSourceCount(row.comment_count),
    postedAt: readSourceTimestamp(row.posted_at) }));
}

export async function listUnembeddedStylePosts(sql: Sql, instanceId: string, limit: number): Promise<UnembeddedStylePost[]> {
  const rows = await sql<UnembeddedStylePost[]>`
    select p.id::text,p.body from noelle.account_style_posts p
    join noelle.agent_instances a on a.id=p.agent_instance_id and a.org_id=p.org_id
    where p.agent_instance_id=${instanceId} and p.embedding is null and p.body<>''
    order by ${corpusEngagementSql(sql)} desc nulls last,p.id limit ${limit}`;
  return [...rows];
}

/** Store vectors only while the captured provider input is still the saved body. */
export async function updateStylePostEmbeddings(sql: Sql, rows: StylePostEmbedding[]): Promise<number> {
  if (!rows.length) return 0;
  const ids = rows.map(row => row.id);
  const bodies = rows.map(row => row.body);
  const vectors = rows.map(row => `[${row.embedding.join(",")}]`);
  const updated = await sql<{ id: string }[]>`
    with owners as materialized (
      select a.id,a.org_id from noelle.agent_instances a
      where exists (select 1 from noelle.account_style_posts p
        where p.id=any(${ids}::uuid[]) and p.agent_instance_id=a.id and p.org_id=a.org_id)
      for share of a
    )
    update noelle.account_style_posts p set embedding=data.emb::vector
    from (select unnest(${ids}::uuid[]) as id,unnest(${vectors}::text[]) as emb,
      unnest(${bodies}::text[]) as body) data,owners a
    where p.id=data.id and p.body=data.body
      and a.id=p.agent_instance_id and a.org_id=p.org_id returning p.id`;
  return updated.length;
}
