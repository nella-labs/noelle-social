import { approvalMemoryJoins, memoryBodySql, trimMemorySql } from "./approvalMemorySql.js";
import type { Sql } from "postgres";

export interface RepliedPostSource {
  leadId: string;
  url: string | null;
  author: string | null;
  post: string;
  reply: string;
  repliedAt: string | null;
}

export interface RepliedPostSourcesArgs {
  orgId: string;
  platform: "linkedin" | "x" | "reddit" | string;
  limit?: number;
}

interface RepliedPostSourceRow {
  lead_id: string;
  url: string | null;
  author: string | null;
  post: string | null;
  reply: string | null;
  replied_at: string | null;
}

const DEFAULT_REPLIED_POST_LIMIT = 40;

function boundedLimit(limit: number | undefined): number {
  if (limit == null) return DEFAULT_REPLIED_POST_LIMIT;
  if (!Number.isFinite(limit)) return DEFAULT_REPLIED_POST_LIMIT;
  return Math.max(0, Math.min(DEFAULT_REPLIED_POST_LIMIT, Math.floor(limit)));
}

/**
 * Posts Noelle has already answered publicly, paired with the exact reply the
 * operator accepted. This is the Apify-free idea source for requested ideation:
 * it reads only saved Noelle data, keeps sent public replies, prefers edited
 * reply bodies, and dedupes to one row per original lead.
 */
export async function getRepliedPostSources(
  sql: Sql,
  args: RepliedPostSourcesArgs,
): Promise<RepliedPostSource[]> {
  const limit = boundedLimit(args.limit);
  if (limit <= 0) return [];

  const rows = await sql<RepliedPostSourceRow[]>`
    with sent_replies as (
      select distinct on (l.id)
        l.id::text as lead_id,
        l.payload->>'url' as url,
        nullif(l.author_handle, '') as author,
        l.payload->>'text' as post,
        ${memoryBodySql(sql)} as reply,
        coalesce(a.decided_at, a.created_at)::text as replied_at
      from noelle.approvals a
      ${approvalMemoryJoins(sql)}
      where a.org_id = ${args.orgId}
        and d.org_id = ${args.orgId}
        and l.org_id = ${args.orgId}
        and l.platform = ${args.platform}
        and a.status = 'sent'
        and coalesce(d.payload->>'kind', 'reply') = 'reply'
        and ${trimMemorySql(sql, sql`l.payload->>'text'`)} <> ''
        and ${trimMemorySql(sql, memoryBodySql(sql))} <> ''
      order by l.id, coalesce(a.decided_at, a.created_at) desc
    )
    select lead_id, url, author, post, reply, replied_at
    from sent_replies
    order by replied_at desc nulls last
    limit ${limit}
  `;

  const seen = new Set<string>();
  const out: RepliedPostSource[] = [];
  for (const row of rows) {
    const post = row.post?.trim();
    const reply = row.reply?.trim();
    if (!post || !reply || seen.has(row.lead_id)) continue;
    seen.add(row.lead_id);
    out.push({
      leadId: row.lead_id,
      url: row.url,
      author: row.author,
      post,
      reply,
      repliedAt: row.replied_at,
    });
  }
  return out;
}
