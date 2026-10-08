import { approvalMemoryJoins, boundedMemoryLimit, memoryBodySql, trimMemorySql } from "./approvalMemorySql.js";
import type { Sql } from "postgres";
import type { OutboundDraftIn } from "@noelle/contracts";

export interface PriorRepliesArgs {
  agentInstanceId: string;
  /** The post author's public id (stable across a person's posts). */
  authorHandle: string | null;
  /** The author's fsd_profile_id, when known (watch lane). null on keyword leads. */
  authorId?: string | null;
  /** Exclude this lead's own drafts (the one being drafted now). */
  excludeLeadId?: string | null;
  /** Maximum prior reply bodies; finite integers are capped at 100. */
  limit: number;
  /** Selected Reddit comment recipient; omitted when replying to the post author. */
  replyTarget?: Pick<NonNullable<OutboundDraftIn["replyTarget"]>, "kind" | "author">;
}

/**
 * Replies previously sent or queued for this author, with sent replies first.
 * Only consistent tenant, instance, and source-post relationships are eligible.
 * An edited_body key is authoritative even when its value is empty or null.
 * Query errors yield an empty optional memory rather than stopping drafting.
 */
export async function getRecentRepliesToAuthor(
  sql: Sql,
  args: PriorRepliesArgs,
): Promise<string[]> {
  const { agentInstanceId, authorHandle, excludeLeadId } = args;
  const limit = boundedMemoryLimit(args.limit);
  if (!limit) return [];
  // Normalize a blank author id to NULL. An empty string would make the
  // `l.author_id = ''` leg of the OR below match every OTHER lead with a blank
  // author_id, i.e. leak another person's replies into this person's memory.
  const authorId = args.authorId && args.authorId.trim() ? args.authorId : null;
  const commentMode = args.replyTarget?.kind === "comment";
  const commentAuthor = typeof args.replyTarget?.author === "string"
    ? args.replyTarget.author.trim().replace(/^\/?u\//i, "").trim().toLowerCase()
    : null;
  if (commentMode ? !commentAuthor : !authorHandle && !authorId) return [];
  try {
    const authorMatch = commentMode
      ? sql`l.platform = 'reddit'
          and jsonb_typeof(d.payload->'reply_target') = 'object'
          and d.payload->'reply_target'->>'kind' = 'comment'
          and jsonb_typeof(d.payload->'reply_target'->'author') = 'string'
          and lower(${trimMemorySql(sql, sql`regexp_replace(
            ${trimMemorySql(sql, sql`d.payload->'reply_target'->>'author'`)}, '^/?u/', '', 'i')`)}) = ${commentAuthor}`
      : sql`(l.platform is distinct from 'reddit' or d.payload->'reply_target'->>'kind' is distinct from 'comment')
          and ((${authorHandle}::text is not null and l.author_handle = ${authorHandle})
            or (${authorId ?? null}::text is not null and l.author_id = ${authorId ?? null}))`;
    const rows = await sql<{ body: string | null }[]>`
      select ${memoryBodySql(sql)} as body
      from noelle.approvals a
      ${approvalMemoryJoins(sql)}
      where a.agent_instance_id = ${agentInstanceId}
        and a.status in ('sent', 'pending')
        and coalesce(d.payload->>'kind', 'reply') = 'reply'
        and ${trimMemorySql(sql, memoryBodySql(sql))} <> ''
        and ${authorMatch}
        and (${excludeLeadId ?? null}::uuid is null or l.id <> ${excludeLeadId ?? null})
      order by (a.status = 'sent') desc, a.decided_at desc nulls last, a.created_at desc
      limit ${limit}
    `;
    // Dedupe identical bodies (the 3 reply angles of one lead can be similar) and
    // drop blanks, preserving order.
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

export interface RecentPhrasingsArgs {
  agentInstanceId: string;
  /** Exclude this lead's own drafts (the one being drafted now). */
  excludeLeadId?: string | null;
  /** Maximum recent reply bodies across all authors; capped at 100. */
  limit: number;
}

/**
 * Recent reply phrasing across the instance's authors, ordered by pure recency.
 * Including pending replies lets the avoid-list cover the current draft queue.
 * Query errors yield an empty optional memory.
 */
export async function getRecentReplyPhrasings(
  sql: Sql,
  args: RecentPhrasingsArgs,
): Promise<string[]> {
  const { agentInstanceId, excludeLeadId } = args;
  const limit = boundedMemoryLimit(args.limit);
  if (!limit) return [];
  try {
    const rows = await sql<{ body: string | null }[]>`
      select ${memoryBodySql(sql)} as body
      from noelle.approvals a
      ${approvalMemoryJoins(sql)}
      where a.agent_instance_id = ${agentInstanceId}
        and a.status in ('sent', 'pending')
        and coalesce(d.payload->>'kind', 'reply') = 'reply'
        and ${trimMemorySql(sql, memoryBodySql(sql))} <> ''
        and (${excludeLeadId ?? null}::uuid is null or l.id <> ${excludeLeadId ?? null})
      order by coalesce(a.decided_at, a.created_at) desc
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

/** One approved reply shown with the post it answered. */
export interface VoiceExemplar {
  post: string;
  reply: string;
}

export interface VoiceExemplarsArgs {
  agentInstanceId: string;
  /** Never show the lead being drafted right now as its own example. */
  excludeLeadId?: string | null;
  /** Maximum pairs; finite integers are capped at 100. */
  limit: number;
  /** LinkedIn actor voice should only learn from a human send or edit. */
  humanOnly?: boolean;
}

/**
 * Sent replies paired with their source posts for voice examples.
 * Reddit comment targets have no saved source-comment body and are excluded.
 * humanOnly requires a manual send or a human edit. Empty replies and posts
 * are excluded before limiting, and query errors yield no optional examples.
 */
export async function getVoiceExemplars(
  sql: Sql,
  args: VoiceExemplarsArgs,
): Promise<VoiceExemplar[]> {
  const { agentInstanceId, excludeLeadId, humanOnly = false } = args;
  const limit = boundedMemoryLimit(args.limit);
  if (!limit) return [];
  try {
    const rows = await sql<{ post: string | null; reply: string | null }[]>`
      select l.payload->>'text' as post,
             ${memoryBodySql(sql)} as reply
      from noelle.approvals a
      ${approvalMemoryJoins(sql)}
      where a.agent_instance_id = ${agentInstanceId}
        and a.status = 'sent'
        and ${trimMemorySql(sql, sql`l.payload->>'text'`)} <> ''
        and coalesce(d.payload->>'kind', 'reply') = 'reply'
        and (l.platform is distinct from 'reddit' or d.payload->'reply_target'->>'kind' is distinct from 'comment')
        and ${trimMemorySql(sql, memoryBodySql(sql))} <> ''
        and (${humanOnly} = false or d.payload->>'sent_via' = 'manual' or nullif(d.payload->>'edited_body', '') is not null)
        and (${excludeLeadId ?? null}::uuid is null or l.id <> ${excludeLeadId ?? null})
      order by coalesce(a.decided_at, a.created_at) desc
      limit ${limit}
    `;
    const seen = new Set<string>();
    const out: VoiceExemplar[] = [];
    for (const r of rows) {
      const post = r.post?.trim();
      const reply = r.reply?.trim();
      if (!post || !reply) continue;
      // The same reply twice teaches nothing and spends the budget twice.
      if (seen.has(reply)) continue;
      seen.add(reply);
      out.push({ post, reply });
    }
    return out;
  } catch {
    return [];
  }
}
