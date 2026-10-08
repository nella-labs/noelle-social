import { createHash } from "node:crypto";
import type { Sql, TransactionSql } from "postgres";
import { RedditReplyItemSchema, type RedditReplyClaimIn } from "@noelle/contracts";
import { BoundedPgSession } from "@noelle/runtime/bounded-pg-session";
import { replyApprovalContextSql } from "./reply-approval-context-sql.js";
import {
  buildActionableReddit,
  resolveRedditDailyWriteCap,
  type RedditJoinedRow,
} from "./reddit-reply-policy.js";

type Snapshot = RedditJoinedRow & { source_sha256: string; draft_sha256: string };
type Claim = {
  body_sha256: string;
  target_sha256: string;
  source_sha256: string;
  draft_sha256: string;
  receipt_draft_sha256: string | null;
  status: string;
};
type ClaimResult = "claimed" | "not-eligible" | "already-claimed" | "daily-cap" | "challenge";
const sessions = new WeakMap<Sql, BoundedPgSession>();
function session(sql: Sql): BoundedPgSession {
  let owner = sessions.get(sql);
  if (!owner) {
    owner = new BoundedPgSession(sql, { deadlineMs: 3000, maxPending: 32, idleTimeoutMs: 1000 });
    sessions.set(sql, owner);
  }
  return owner;
}
const hash = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");

/** Approval alias a remains reserved after any unknown browser outcome. */
export function redditReplyClaimSql(tx: TransactionSql) {
  return tx`exists(select 1 from noelle.reddit_reply_claims claim
    where claim.org_id=a.org_id and claim.approval_id=a.id)`;
}

/** Canonical jsonb text is hashed in PostgreSQL; only the builder's input channels leave SQL. */
async function snapshot(
  tx: TransactionSql,
  orgId: string,
  approvalId: string,
): Promise<Snapshot | null> {
  const draftFields = tx`jsonb_build_object('kind',d.payload->'kind','body',d.payload->'body',
    'edited_body',d.payload->'edited_body','human_review_required',d.payload->'human_review_required',
    'human_send_approved',d.payload->'human_send_approved',
    'reply_target',jsonb_build_object('kind',d.payload->'reply_target'->'kind',
      'commentId',d.payload->'reply_target'->'commentId','permalink',d.payload->'reply_target'->'permalink',
      'author',d.payload->'reply_target'->'author'))`;
  const leadFields = tx`jsonb_build_object('subreddit',l.payload->'subreddit','url',l.payload->'url',
    'original_post_url',l.payload->'original_post_url','original_post_id',l.payload->'original_post_id',
    'author_handle',l.payload->'author_handle')`;
  const [row] = await tx<Snapshot[]>`
    select a.id as approval_id,d.id as draft_id,l.id as lead_id,
      ${draftFields} as draft_payload,${leadFields} as lead_payload,l.author_handle,l.external_id,
      encode(sha256(convert_to(jsonb_build_array(l.payload,l.external_id,l.author_handle)::text,'UTF8')),'hex') as source_sha256,
      encode(sha256(convert_to(d.payload::text,'UTF8')),'hex') as draft_sha256
    from noelle.approvals a join noelle.drafts d on d.id=a.draft_id join noelle.leads l on l.id=a.lead_id
    where a.org_id=${orgId} and a.id=${approvalId} and l.platform='reddit'
      and ${replyApprovalContextSql(tx)}
      and octet_length(coalesce(d.payload->>'edited_body',d.payload->>'body',''))<=65536
      and octet_length(jsonb_build_array(${draftFields},${leadFields},l.author_handle,l.external_id)::text)<=131072`;
  return row ?? null;
}

async function replyUsage(sql: Sql | TransactionSql, orgId: string): Promise<number> {
  const [row] = await sql<{ n: number }[]>`
    select (select count(*) from noelle.reddit_reply_claims
      where org_id=${orgId} and claimed_at>=date_trunc('day',now()))::int
      + (select count(*) from noelle.reddit_activity act where act.organization_id=${orgId}
        and act.type='reply' and act.created_at>=date_trunc('day',now())
        and not exists(select 1 from noelle.reddit_reply_claims claim where claim.org_id=${orgId}
          and claim.approval_id=act.approval_id and claim.claimed_at>=date_trunc('day',now())))::int as n`;
  if (!row) throw new Error("Reddit usage unavailable");
  return row.n;
}

export function readRedditReplyUsage(sql: Sql, orgId: string): Promise<number> {
  return session(sql).run((db) => replyUsage(db, orgId));
}

/** Selected IDs only: the browser queue never loads the complete retained claim history. */
export function readClaimedRedditPosts(
  sql: Sql,
  orgId: string,
  postIds: string[],
): Promise<Set<string>> {
  if (postIds.length > 500) throw new RangeError("Too many Reddit claim candidates");
  if (!postIds.length) return Promise.resolve(new Set());
  return session(sql).run(async (db) => {
    const rows = await db<{ post_id: string }[]>`select post_id from noelle.reddit_reply_claims
      where org_id=${orgId} and post_id=any(${postIds}::text[])`;
    return new Set(rows.map((row) => row.post_id));
  });
}

/** Quota, fresh saved input, consent and a permanent org/thread reservation commit together. */
export function reserveRedditBrowserReply(
  sql: Sql,
  orgId: string,
  request: RedditReplyClaimIn,
  options: { blockExternalLinks: boolean; haltOnChallenge: boolean; dailyCapRaw?: string },
): Promise<ClaimResult> {
  return session(sql).run(
    async (db) =>
      db.begin(async (tx) => {
        await tx`set local lock_timeout='1s'`;
        await tx`set local statement_timeout='2s'`;
        await tx`set local idle_in_transaction_session_timeout='3s'`;
        if (!(await tx`select id from noelle.organizations where id=${orgId} for update`).length)
          return "not-eligible";
        const [parent] = await tx<
          { id: string; reply_send_enabled: boolean; auto_send_enabled: boolean }[]
        >`
      select id,reply_send_enabled,auto_send_enabled from noelle.agent_instances
      where id=${request.instance_id} and org_id=${orgId} and role='reddit_intern' and status='active' for no key update`;
        if (!parent || (!parent.reply_send_enabled && !parent.auto_send_enabled))
          return "not-eligible";
        const reply = request.reply;
        await tx`select id from noelle.drafts where id=${reply.draft_id} and org_id=${orgId} for update`;
        await tx`select id from noelle.approvals where id=${reply.approval_id} and org_id=${orgId} for update`;
        await tx`select id from noelle.leads where id=${reply.lead_id} and org_id=${orgId} for no key update`;
        const [eligible] =
          await tx`select a.id from noelle.approvals a join noelle.drafts d on d.id=a.draft_id
      join noelle.leads l on l.id=a.lead_id where a.id=${reply.approval_id} and a.org_id=${orgId}
      and a.agent_instance_id=${request.instance_id} and d.id=${reply.draft_id} and l.id=${reply.lead_id}
      and a.status='pending' and d.sent_external_id is null and d.sent_at is null and d.posted_at is null
      and ${replyApprovalContextSql(tx)}`;
        if (!eligible) return "not-eligible";
        const row = await snapshot(tx, orgId, reply.approval_id);
        if (!row) return "not-eligible";
        const current = buildActionableReddit([row], undefined, options).replies[0];
        if (
          !current ||
          JSON.stringify(RedditReplyItemSchema.parse(current)) !== JSON.stringify(reply)
        )
          return "not-eligible";
        if (
          options.haltOnChallenge &&
          (
            await tx<{ n: number }[]>`select count(*)::int as n from noelle.reddit_activity
      where organization_id=${orgId} and reason in ('challenge','throttle')
      and created_at>=now()-interval '1 hour'`
          )[0]?.n !== 0
        )
          return "challenge";
        const cap = resolveRedditDailyWriteCap(options.dailyCapRaw);
        if (Number.isFinite(cap) && (await replyUsage(tx, orgId)) >= cap) return "daily-cap";
        const postId = current.target.post_id!;
        const [prior] = await tx`select 1 where exists(select 1 from noelle.reddit_reply_claims
      where org_id=${orgId} and (approval_id=${reply.approval_id} or draft_id=${reply.draft_id}))
      or exists(select 1 from noelle.reddit_activity
      where organization_id=${orgId} and type='reply' and lower(regexp_replace(post_id,'^t3_','','i'))=${postId})
      or exists(select 1 from noelle.approvals a join noelle.drafts d on d.id=a.draft_id
        join noelle.leads l on l.id=a.lead_id where a.org_id=${orgId} and a.status='sent'
        and l.platform='reddit' and coalesce(d.payload->>'kind','reply')='reply'
        and lower(regexp_replace(l.external_id,'^t3_','','i'))=${postId} and ${replyApprovalContextSql(tx)})`;
        if (prior) return "already-claimed";
        const inserted =
          await tx`insert into noelle.reddit_reply_claims(org_id,post_id,agent_instance_id,
      approval_id,draft_id,lead_id,body_sha256,target_sha256,source_sha256,draft_sha256)
      values(${orgId},${postId},${request.instance_id},${reply.approval_id},${reply.draft_id},${reply.lead_id},
        ${hash(current.body)},${hash(JSON.stringify(RedditReplyItemSchema.parse(current).target))},
        ${row.source_sha256},${row.draft_sha256}) on conflict do nothing returning post_id`;
        return inserted.length ? "claimed" : "already-claimed";
      }) as Promise<ClaimResult>,
  );
}

/** The caller already holds parent/draft/approval locks in canonical order. */
export async function matchesRedditClaim(
  tx: TransactionSql,
  orgId: string,
  approvalId: string,
): Promise<boolean> {
  const [claim] = await tx<Claim[]>`select claim.* from noelle.reddit_reply_claims claim
    join noelle.approvals a on a.id=claim.approval_id and a.org_id=claim.org_id
    join noelle.agent_instances ai on ai.id=claim.agent_instance_id and ai.org_id=claim.org_id
    where claim.org_id=${orgId} and claim.approval_id=${approvalId} and ai.role='reddit_intern' and ai.status='active'
      and a.agent_instance_id=claim.agent_instance_id and a.draft_id=claim.draft_id and a.lead_id=claim.lead_id
    for update of claim`;
  if (!claim) return false;
  const row = await snapshot(tx, orgId, approvalId);
  const current = row && buildActionableReddit([row]).replies[0];
  return (
    !!current &&
    hash(current.body) === claim.body_sha256 &&
    hash(JSON.stringify(RedditReplyItemSchema.parse(current).target)) === claim.target_sha256 &&
    row!.source_sha256 === claim.source_sha256 &&
    row!.draft_sha256 ===
      (claim.status === "sent" ? claim.receipt_draft_sha256 : claim.draft_sha256)
  );
}

export async function recordRedditClaimSent(
  tx: TransactionSql,
  orgId: string,
  approvalId: string,
): Promise<void> {
  await tx`update noelle.reddit_reply_claims claim set status='sent',sent_at=coalesce(claim.sent_at,now()),
    receipt_draft_sha256=encode(sha256(convert_to(d.payload::text,'UTF8')),'hex')
    from noelle.drafts d where claim.org_id=${orgId} and claim.approval_id=${approvalId}
      and d.id=claim.draft_id and d.org_id=claim.org_id`;
}
