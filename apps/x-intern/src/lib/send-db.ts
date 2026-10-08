import type { Sql } from "postgres";
import type { PendingDraft } from "../workers/send-tick.js";
import { sourceTimestampSql, xReplyAgeCutoffSql, unattendedReplyReviewSql, replyApprovalContextSql } from "@noelle/runtime";

/** Read only bounded, undispatched retry work for one native X instance. */
export async function listRetrySendDue(
  sql: Sql,
  args: { agentInstanceId: string; orgId: string; maxAgeHours: number },
): Promise<PendingDraft[]> {
  const rows = await sql<PendingDraft[]>`
    select d.id as draft_id,
      coalesce(d.payload->>'edited_body', d.payload->>'body') as body,
      l.external_id as in_reply_to_id, d.lead_id as lead_id, a.decided_by as decided_by
    from noelle.drafts d
    join noelle.approvals a on a.draft_id=d.id
    join noelle.leads l on l.id=d.lead_id
    where a.status='sent' and d.sent_external_id is null and d.sent_at is null
      and ${replyApprovalContextSql(sql)}
      and a.org_id=${args.orgId} and a.agent_instance_id=${args.agentInstanceId}
      and not exists (select 1 from noelle.x_reply_claims claim
        where claim.org_id=${args.orgId} and claim.tweet_id=l.external_id)
      and l.org_id=${args.orgId} and l.agent_instance_id=${args.agentInstanceId}
      and coalesce(d.payload->>'kind','reply') <> 'dm'
      ${args.maxAgeHours > 0 ? sql`and (
        ${sourceTimestampSql(sql, sql`l.payload->>'posted_at'`)} is null
        or ${sourceTimestampSql(sql, sql`l.payload->>'posted_at'`)} >= ${xReplyAgeCutoffSql(sql, sql`l.payload`, args.maxAgeHours)}
      )` : sql``}
    order by a.decided_at desc limit 5
  `;
  return [...rows];
}

/**
 * Claim up to `budget` auto-send-due approvals for this instance and
 * return them shaped like `PendingDraft` for runSendTick. An instance row lock
 * serializes rolling budget checks; the CTE atomically
 * flips status='pending' → 'sent' (with decided_by='auto-send', decided_at=now)
 * BEFORE returning, so concurrent send workers can't double-pick the same
 * row. `FOR UPDATE SKIP LOCKED` is the safety belt.
 *
 * The send-tick path then posts each row to X and writes sent_external_id
 * via the existing markSent callback. If the X post fails the row stays
 * status='sent' with no external_id — same retry shape as a row claimed
 * via the human Send button.
 */
export async function claimAutoSendDue(
  sql: Sql,
  args: { agentInstanceId: string; budget: number; maxAgeHours?: number; maxPerDay?: number; maxPer30Min?: number },
): Promise<PendingDraft[]> {
  if (!Number.isFinite(args.budget) || args.budget < 1) return [];
  const maxAge = args.maxAgeHours ?? 0;
  const cap = (value: number | undefined, fallback: number) => value !== undefined && Number.isFinite(value)
    ? Math.max(0, Math.floor(value)) : fallback;
  return sql.begin(async (tx) => {
    await tx`set local lock_timeout = '5s'`;
    await tx`set local statement_timeout = '10s'`;
    const [owner] = await tx<{ org_id: string; hourly_cap: number }[]>`
      select org_id,auto_send_max_per_hour as hourly_cap from noelle.agent_instances
      where id=${args.agentInstanceId} and role='x_intern' and status in ('active','paused')
        and send_enabled=true and reply_send_enabled=true for update
    `;
    if (!owner) return [];
    // This statement starts after the instance lock, so concurrent claimants'
    // committed usage is visible before computing the remaining rolling budget.
    const [usage] = await tx<{ hour: number; day: number; half_hour: number }[]>`
      select count(*) filter (where decided_at>=now()-interval '1 hour')::int as hour,
        count(*)::int as day,count(*) filter (where decided_at>=now()-interval '30 minutes')::int as half_hour
      from noelle.approvals where agent_instance_id=${args.agentInstanceId} and org_id=${owner.org_id}
        and status='sent' and decided_by='auto-send' and decided_at>=now()-interval '24 hours'
    `;
    const remaining = Math.min(Math.floor(args.budget),100,cap(owner.hourly_cap,6)-(usage?.hour ?? 0),
      cap(args.maxPerDay,50)-(usage?.day ?? 0),cap(args.maxPer30Min,6)-(usage?.half_hour ?? 0));
    if (remaining <= 0) return [];
    const rows = await tx<PendingDraft[]>`
    with claimed as (
      update noelle.approvals
      set status = 'sent',
          decided_at = now(),
          decided_by = 'auto-send'
      where id in (
        select a.id from noelle.approvals a
        where status = 'pending'
          and auto_send_target_at is not null
          and auto_send_target_at <= now()
          and agent_instance_id = ${args.agentInstanceId}
          and org_id = ${owner.org_id}
          and exists (
            select 1 from noelle.drafts d join noelle.leads l on l.id=d.lead_id
            where ${replyApprovalContextSql(tx)}
              and coalesce(d.payload->>'kind','reply') = 'reply'
              and d.sent_external_id is null and d.sent_at is null
              and ${unattendedReplyReviewSql(tx, tx`d.payload`)}
          -- Freshness (X_REPLY_MAX_AGE_HOURS, 0 = off): never auto-post a
          -- reply whose target tweet has aged out. expireStaleApprovals is the
          -- sweep; this predicate is the same-tick belt.
          ${
            maxAge > 0
              ? tx`and (
                  ${sourceTimestampSql(tx, tx`l.payload->>'posted_at'`)} is null
                  or ${sourceTimestampSql(tx, tx`l.payload->>'posted_at'`)} >= ${xReplyAgeCutoffSql(tx, tx`l.payload`, maxAge)}
                )`
              : tx``
          }
          )
        order by auto_send_target_at asc
        for update skip locked
        limit ${remaining}
      )
      returning id, draft_id, lead_id
    )
    select d.id                                                    as draft_id,
           coalesce(d.payload->>'edited_body', d.payload->>'body') as body,
           l.external_id                                           as in_reply_to_id,
           d.lead_id                                               as lead_id
    from claimed c
    join noelle.drafts d on d.id = c.draft_id
    join noelle.leads  l on l.id = c.lead_id
  `;
    return [...rows];
  });
}

/**
 * Freshness sweep (X_REPLY_MAX_AGE_HOURS): flip reply approvals whose TARGET
 * TWEET has aged out to status='expired' so they can never send. Two shapes:
 *
 *  - pending — still waiting in the review inbox. Expiring them keeps the
 *    inbox honest (only actionable, still-fresh replies) and stops a re-armed
 *    sender from draining weeks of necro-replies oldest-first.
 *  - limbo — flipped to 'sent' (human click or auto-claim) but never actually
 *    posted (no sent_external_id, no sent_at). Without this they sit in the
 *    retry queue forever once their tweet is stale.
 *
 * DMs and Jev-qualified browser observations are exempt.
 * 'expired' is terminal: nothing reads it as actionable, the dashboard just
 * stops counting it as pending. Fail-open on undateable tweets (no posted_at).
 */
export async function expireStaleApprovals(
  sql: Sql,
  args: { agentInstanceId: string; maxAgeHours: number },
): Promise<{ pending: number; limbo: number }> {
  if (args.maxAgeHours <= 0) return { pending: 0, limbo: 0 };
  const staleTweet = () => sql`
    l.payload->>'source' is distinct from 'extension_observed'
    and ${sourceTimestampSql(sql, sql`l.payload->>'posted_at'`)} < ${xReplyAgeCutoffSql(sql, sql`l.payload`, args.maxAgeHours)}
  `;
  const reason = `expired: target tweet older than ${args.maxAgeHours}h`;
  const pending = await sql<{ id: string }[]>`
    update noelle.approvals a
    set status = 'expired',
        decided_at = now(),
        decided_by = 'system',
        skip_reason = ${reason},
        updated_at = now()
    from noelle.drafts d, noelle.leads l
    where d.id = a.draft_id
      and l.id = a.lead_id
      and ${replyApprovalContextSql(sql)}
      and a.agent_instance_id = ${args.agentInstanceId}
      and a.status = 'pending'
      and coalesce(d.payload->>'kind', 'reply') <> 'dm'
      and not (
        d.payload->>'human_review_required' is not distinct from 'true'
        and d.payload->>'human_send_approved' is distinct from 'true'
      )
      and ${staleTweet()}
    returning a.id
  `;
  const limbo = await sql<{ id: string }[]>`
    update noelle.approvals a
    set status = 'expired',
        decided_at = coalesce(a.decided_at, now()),
        skip_reason = ${reason},
        updated_at = now()
    from noelle.drafts d, noelle.leads l
    where d.id = a.draft_id
      and l.id = a.lead_id
      and ${replyApprovalContextSql(sql)}
      and a.agent_instance_id = ${args.agentInstanceId}
      and a.status = 'sent'
      and d.sent_external_id is null
      and d.sent_at is null
      and coalesce(d.payload->>'kind', 'reply') <> 'dm'
      and ${staleTweet()}
    returning a.id
  `;
  return { pending: pending.length, limbo: limbo.length };
}

/** Revert claimed auto-send rows back to the human-review inbox (status='pending',
 *  auto_send_target_at nulled so they are not re-claimed). Used when a claimed row
 *  turns out to carry an external link. Only touches decided_by='auto-send' rows. */
export async function releaseAutoSendRowsForReview(
  sql: Sql,
  args: { draftIds: string[] },
): Promise<void> {
  const ids = [...new Set(args.draftIds)].slice(0,200);
  if (ids.length === 0) return;
  await sql.begin(async (tx) => {
    await tx`set local lock_timeout = '5s'`;
