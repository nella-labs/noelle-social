import type { Sql, TransactionSql } from "postgres";
import { PatternFindingSchema, UuidSchema, type PatternFinding } from "@noelle/contracts";
import { replyApprovalContextSql } from "../replyApprovalContextSql.js";
import {
  patternOwner,
  patternRead,
  validPatternScope,
  type PatternScope,
  type PatternReadClient,
  type PatternSql,
} from "./dbContext.js";

export const PATTERN_CORPUS_LIMIT = 100;
export const PATTERN_BODY_LIMIT = 10000;
export interface RecentPost {
  draftId: string;
  body: string;
  kind: "reply" | "post";
  platform: string;
}

function replyBody(sql: PatternSql) {
  return sql`case
    when jsonb_typeof(d.payload->'edited_body')='string' and btrim(d.payload->>'edited_body')<>''
      then case when length(d.payload->>'edited_body')<=${PATTERN_BODY_LIMIT} then d.payload->>'edited_body' end
    when jsonb_typeof(d.payload->'body')='string' and length(d.payload->>'body')<=${PATTERN_BODY_LIMIT}
      then d.payload->>'body' end`;
}
/** Admit complete bodies, never excerpts masquerading as the analyzed source. */
export function patternCorpusSql(sql: PatternSql, scope: PatternScope) {
  return sql`select source.* from (
    select distinct on (d.id) d.id as draft_id, ${replyBody(sql)} as body, 'reply'::text as kind,
      l.platform, coalesce(d.sent_at,a.decided_at,a.created_at) as at
    from noelle.drafts d join noelle.approvals a on a.draft_id=d.id
    join noelle.leads l on l.id=a.lead_id
    where a.org_id=${scope.orgId} and a.agent_instance_id=${scope.agentInstanceId}
      and ${replyApprovalContextSql(sql)} and a.status='sent' and d.payload->>'kind'='reply'
      and (d.sent_at is not null or nullif(btrim(d.sent_external_id),'') is not null)
    order by d.id, coalesce(d.sent_at,a.decided_at,a.created_at) desc, a.id
  ) source where source.body is not null and btrim(source.body)<>''
  union all
  select pd.id as draft_id, case when nullif(btrim(pd.final_body),'') is not null
      then pd.final_body else pd.body end as body, 'post'::text as kind, pd.platform, pd.created_at as at
  from noelle.post_drafts pd join noelle.post_ideas i on i.id=pd.idea_id
    and i.org_id=pd.org_id and i.agent_instance_id=pd.agent_instance_id and i.platform=pd.platform
  where pd.org_id=${scope.orgId} and pd.agent_instance_id=${scope.agentInstanceId} and pd.status='published'
    and length(case when nullif(btrim(pd.final_body),'') is not null then pd.final_body else pd.body end)<=${PATTERN_BODY_LIMIT}
    and btrim(case when nullif(btrim(pd.final_body),'') is not null then pd.final_body else pd.body end)<>''`;
}
export async function loadRecentPosts(
  client: Sql | PatternReadClient,
  scope: PatternScope,
  max = PATTERN_CORPUS_LIMIT,
): Promise<RecentPost[]> {
  if (!validPatternScope(scope)) return [];
  const limit = Number.isFinite(max)
    ? Math.max(1, Math.min(PATTERN_CORPUS_LIMIT, Math.floor(max)))
    : PATTERN_CORPUS_LIMIT;
  return patternRead(client, async (query, sql) => {
    const rows = await query<
      { draft_id: string; body: string; kind: "reply" | "post"; platform: string }[]
    >`
      with owner as materialized (${patternOwner(sql, scope)}), corpus as (${patternCorpusSql(sql, scope)})
      select draft_id,body,kind,platform from corpus where exists(select 1 from owner)
      order by at desc nulls last,kind,draft_id limit ${limit}`;
    return rows.map((row) => ({
      draftId: row.draft_id,
      body: row.body,
      kind: row.kind,
      platform: row.platform,
    }));
  });
}
export function validCapturedCorpus(posts: RecentPost[]): boolean {
  return (
    Array.isArray(posts) &&
    posts.length > 0 &&
    posts.length <= PATTERN_CORPUS_LIMIT &&
    posts.every(
      (p) =>
        UuidSchema.safeParse(p.draftId).success &&
        ["reply", "post"].includes(p.kind) &&
        typeof p.body === "string" &&
        p.body.trim() !== "" &&
        p.body.length <= PATTERN_BODY_LIMIT &&
        typeof p.platform === "string" &&
        p.platform.length <= 32,
    ) &&
    new Set(posts.map((p) => p.kind + ":" + p.draftId.toLowerCase())).size === posts.length
  );
}
/** Lock the captured sources in parent/source order, then recheck exact analyzed bodies and provenance. */
export async function lockCapturedCorpus(
  tx: TransactionSql,
  scope: PatternScope,
  posts: RecentPost[],
): Promise<boolean> {
  const replies = posts.filter((p) => p.kind === "reply").map((p) => p.draftId);
  const originals = posts.filter((p) => p.kind === "post").map((p) => p.draftId);
  if (replies.length) {
    await tx`select l.id from noelle.leads l join noelle.drafts d on d.lead_id=l.id
      where d.id=any(${replies}::uuid[]) order by l.id for share of l`;
    await tx`select id from noelle.drafts where id=any(${replies}::uuid[]) order by id for share`;
    await tx`select id from noelle.approvals where draft_id=any(${replies}::uuid[]) order by id for share`;
  }
  if (originals.length) {
    await tx`select i.id from noelle.post_ideas i join noelle.post_drafts d on d.idea_id=i.id
      where d.id=any(${originals}::uuid[]) order by i.id for share of i`;
    await tx`select id from noelle.post_drafts where id=any(${originals}::uuid[]) order by id for share`;
  }
  const rows = await tx<{ draft_id: string; body: string; kind: string; platform: string }[]>`
    select draft_id,body,kind,platform from (${patternCorpusSql(tx, scope)}) corpus
    where draft_id=any(${posts.map((p) => p.draftId)}::uuid[])`;
  const current = new Map(rows.map((r) => [r.kind + ":" + r.draft_id, r]));
  return posts.every((p) => {
    const row = current.get(p.kind + ":" + p.draftId.toLowerCase());
    return row?.body === p.body && row.platform === p.platform;
  });
}
export function validFindingEvidence(
  finding: PatternFinding,
  posts: RecentPost[],
  windowSize: number,
): boolean {
  if (
    !PatternFindingSchema.safeParse(finding).success ||
    !Number.isInteger(windowSize) ||
    windowSize < 1 ||
    windowSize > posts.length ||
    finding.frequencyCount > windowSize
  )
    return false;
  const normalized = (body: string) => body.replace(/\s+/g, " ").trim();
  return finding.examples.every(
    (example) =>
      typeof example.draftId === "string" &&
      posts
        .slice(0, windowSize)
        .some(
          (p) =>
            p.draftId.toLowerCase() === example.draftId!.toLowerCase() &&
            normalized(p.body).includes(normalized(example.snippet)),
        ),
  );
}
