import { approvalMemoryJoins, boundedMemoryLimit, memoryBodySql, trimMemorySql } from "./approvalMemorySql.js";
import type { Sql } from "postgres";

// DB helpers for the progressive DM ladder. Mirrors priorReplies.ts (the
// per-person reply memory) but for DMs: how many DMs were already SENT to a
// person (the ladder's stage signal) and the DM bodies already produced for them
// (so the next rung doesn't repeat an earlier opener). Matched by author_handle
// (the LinkedIn public id, stable across a person's posts) OR author_id.

export interface DmAuthorArgs {
  agentInstanceId: string;
  /** The person's public id (author_handle on their DM/reply leads). */
  authorHandle: string | null;
  /** The person's fsd_profile_id, when known (watch lane). */
  authorId?: string | null;
}

/**
 * How many DMs Lyra has already SENT to ONE person — the ladder's stage signal:
 * 0 sent → rung 1 (Open), 1 → Deepen, 2 → Bridge, 3+ → rung 4 (Invite). Counts
 * approvals with `status='sent'` whose draft is `kind='dm'`, matched by
 * author_handle or author_id. Returns 0 on any error or when no author key is
 * known (fail-safe: an unknown person simply starts at rung 1).
 */
export async function countSentDmsToAuthor(sql: Sql, args: DmAuthorArgs): Promise<number> {
  const { agentInstanceId, authorHandle } = args;
  // Blank ids normalise to NULL: an empty string would bind `author_id = ''` and
  // match every OTHER person with a blank id, inflating someone's rung with
  // strangers' DMs. Same defect fixed in priorReplies.ts.
  const authorId = args.authorId && args.authorId.trim() ? args.authorId : null;
  if (!authorHandle && !authorId) return 0;
  try {
    const rows = await sql<{ n: number }[]>`
      select count(*)::int as n
      from noelle.approvals a
      ${approvalMemoryJoins(sql)}
      where a.agent_instance_id = ${agentInstanceId}
        and a.status = 'sent'
        and coalesce(d.payload->>'kind', 'reply') = 'dm'
        and (
          (${authorHandle}::text is not null and l.author_handle = ${authorHandle})
          or (${authorId ?? null}::text is not null and l.author_id = ${authorId ?? null})
        )
    `;
    return Number(rows[0]?.n ?? 0);
  } catch {
    return 0;
  }
}

export interface RecentDmsArgs extends DmAuthorArgs {
  /** Exclude this lead's own drafts (the one being drafted now). */
  excludeLeadId?: string | null;
  /** How many prior DM bodies to return. <=0 → []. */
  limit: number;
}

/**
 * The DM bodies Lyra has ALREADY produced for ONE person — sent + still pending —
 * newest first, so the next rung doesn't repeat an earlier opener/take/question.
 * Prefers the operator's `edited_body` when they revised before sending. Mirrors
 * getRecentRepliesToAuthor but `kind='dm'`. Returns [] on any error (fail-open).
 */
export async function getRecentDmsToAuthor(sql: Sql, args: RecentDmsArgs): Promise<string[]> {
  const { agentInstanceId, authorHandle, excludeLeadId } = args;
  const limit = boundedMemoryLimit(args.limit);
  // Blank ids normalise to NULL — an empty string would bind `author_id = ''`
  // and match every OTHER person with a blank id (same defect fixed in the
  // sibling above and in priorReplies.ts).
  const authorId = args.authorId && args.authorId.trim() ? args.authorId : null;
  if (limit <= 0) return [];
  if (!authorHandle && !authorId) return [];
  try {
    const rows = await sql<{ body: string | null }[]>`
      select ${memoryBodySql(sql)} as body
      from noelle.approvals a
      ${approvalMemoryJoins(sql)}
      where a.agent_instance_id = ${agentInstanceId}
        and a.status in ('sent', 'pending')
        and ${trimMemorySql(sql, memoryBodySql(sql))} <> ''
        and coalesce(d.payload->>'kind', 'reply') = 'dm'
        and (
          (${authorHandle}::text is not null and l.author_handle = ${authorHandle})
          or (${authorId ?? null}::text is not null and l.author_id = ${authorId ?? null})
        )
        and (${excludeLeadId ?? null}::uuid is null or l.id <> ${excludeLeadId ?? null})
      order by (a.status = 'sent') desc, a.decided_at desc nulls last, a.created_at desc
      limit ${limit}
    `;
    const seen = new Set<string>();
    const out: string[] = [];
    for (const r of rows) {
      const body = r.body?.trim();
      if (!body || seen.has(body)) continue;
      seen.add(body);
      out.push(body);
    }
    return out;
  } catch {
    return [];
  }
}
