import type { Sql } from "postgres";
import type { StyleExemplarRow } from "./styleTypes.js";
import { readSourceCount, readSourceTimestamp } from "./sourceValues.js";
import { corpusEngagementSql } from "./accountCorpusMetrics.js";

export function parsePgVector(value: string | null | undefined): number[] | null {
  if (!value) return null;
  try {
    const array: unknown = JSON.parse(value);
    return Array.isArray(array) && array.every(n => typeof n === "number" && Number.isFinite(n)) ? array : null;
  } catch { return null; }
}

interface ExemplarRow {
  external_id: string; body: string; like_count: string | null; comment_count: string | null;
  account_handle: string; posted_at: string | null; embedding: string | null;
}
function normalize(row: ExemplarRow): StyleExemplarRow {
  return { ...row, like_count: readSourceCount(row.like_count), comment_count: readSourceCount(row.comment_count),
    posted_at: readSourceTimestamp(row.posted_at), embedding: parsePgVector(row.embedding) };
}

/** Enabled source pool; a positive performance floor requires measured engagement. */
export async function listStyleExemplars(sql: Sql, args: {
  agentInstanceId: string; platform: string; kind: "post" | "comment"; limit: number;
  minPerformancePercentile?: number;
}): Promise<StyleExemplarRow[]> {
  const floor = Math.max(0, Math.min(100, args.minPerformancePercentile ?? 0)) / 100;
  const rows = await sql<ExemplarRow[]>`
    with eligible as (
      select p.id, p.external_id, p.body, p.like_count, p.comment_count, p.account_handle,
        p.posted_at, p.embedding, ${corpusEngagementSql(sql)} as engagement
      from noelle.account_style_posts p
      join noelle.agent_instances a on a.id=p.agent_instance_id and a.org_id=p.org_id
      where p.agent_instance_id=${args.agentInstanceId} and p.platform=${args.platform}
        and p.kind=${args.kind} and p.body<>''
        and exists (select 1 from noelle.account_feeder_sources s
          where s.agent_instance_id=p.agent_instance_id and s.org_id=p.org_id
            and s.platform=p.platform and lower(s.handle)=lower(p.account_handle) and s.enabled=true)
    ), measured as (
      select id,case when count(*) over ()=1 then 1
        else percent_rank() over (order by engagement) end as perf_pct
      from eligible where engagement is not null
    )
    select e.external_id, e.body, e.like_count::text, e.comment_count::text, e.account_handle,
      e.posted_at::text, e.embedding::text
    from eligible e left join measured m on m.id=e.id
    where ${floor}=0 or m.perf_pct >= ${floor}
    order by e.engagement desc nulls last, e.posted_at desc nulls last, e.id
    limit ${args.limit}`;
  return rows.map(normalize);
}

/** A pinned source remains usable while disabled; its counts retain unknowns. */
export async function listStyleExemplarsForHandle(sql: Sql, args: {
  agentInstanceId: string; platform: string; kind: "post" | "comment"; handle: string; limit: number;
}): Promise<StyleExemplarRow[]> {
  const rows = await sql<ExemplarRow[]>`
    select p.external_id,p.body,p.like_count::text,p.comment_count::text,p.account_handle,
      p.posted_at::text,p.embedding::text
    from noelle.account_style_posts p
    join noelle.agent_instances a on a.id=p.agent_instance_id and a.org_id=p.org_id
    where p.agent_instance_id=${args.agentInstanceId} and p.platform=${args.platform}
      and p.kind=${args.kind} and lower(p.account_handle)=lower(${args.handle}) and p.body<>''
    order by ${corpusEngagementSql(sql)} desc nulls last,p.posted_at desc nulls last,p.id
    limit ${args.limit}`;
  return rows.map(normalize);
}
