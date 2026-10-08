import type { JSONValue, Sql } from "postgres";
import { unattendedReplyReviewSql } from "@noelle/runtime";
import { replyApprovalContextSql } from "./reply-approval-context-sql.js";
import { resolveBrowserReplyCap } from "./browser-reply-cap.js";

type ClaimOutcome = "claimed" | "not-eligible" | "already-claimed" | "daily-cap";

/** Commit one post reservation with fresh authorization and its org-wide quota. */
export async function reserveLinkedInBrowserReply(sql: Sql, args: {
  orgId: string; instanceId: string; approvalId: string; draftId: string; leadId: string;
  activityUrn: string; body: string; draftPayload: unknown; leadPayload: unknown;
  voiceFloor: number; combinedWriteCap: number | null;
}): Promise<ClaimOutcome> {
  return sql.begin(async tx => {
    await tx`set local lock_timeout='5s'`;
    await tx`set local statement_timeout='10s'`;
    await tx`select id from noelle.organizations where id=${args.orgId} for update`;
    const [instance] = await tx<{ actuator_daily_reply_cap: number | null }[]>`
      select actuator_daily_reply_cap from noelle.agent_instances
      where id=${args.instanceId} and org_id=${args.orgId} for update
    `;
    if (!instance) return "not-eligible";
    // Lock in the same order as review mutations, then read a fresh snapshot.
    if (!(await tx`select id from noelle.drafts where id=${args.draftId} and org_id=${args.orgId} for update`).length) return "not-eligible";
    if (!(await tx`select id from noelle.approvals where id=${args.approvalId} and org_id=${args.orgId} for update`).length) return "not-eligible";
    if (!(await tx`select id from noelle.leads where id=${args.leadId} and org_id=${args.orgId} for no key update`).length) return "not-eligible";
    const replyCap = resolveBrowserReplyCap("linkedin", instance.actuator_daily_reply_cap);
    if (replyCap !== null || args.combinedWriteCap !== null) {
      const [count] = await tx<{ n: number }[]>`
        select (
          (select count(*) from noelle.linkedin_reply_claims claim
           where claim.org_id=${args.orgId} and claim.claimed_at>=date_trunc('day',now()))
          + (select count(*) from noelle.linkedin_activity act
             where act.org_id=${args.orgId} and act.type='comment' and act.created_at>=date_trunc('day',now())
               and not exists(select 1 from noelle.linkedin_reply_claims claim
                 where claim.org_id=${args.orgId} and claim.claimed_at>=date_trunc('day',now())
                   and claim.activity_urn=act.activity_urn))
        )::int as n
      `;
      const used = count?.n ?? Number.POSITIVE_INFINITY;
      if (replyCap !== null && used >= replyCap) return "daily-cap";
      if (args.combinedWriteCap !== null) {
        const [dms] = await tx<{ n: number }[]>`select count(*)::int as n from noelle.linkedin_activity
          where org_id=${args.orgId} and type='dm' and created_at>=date_trunc('day',now())`;
        if (used + (dms?.n ?? Number.POSITIVE_INFINITY) >= args.combinedWriteCap) return "daily-cap";
      }
    }
    const inserted = await tx<{ activity_urn: string }[]>`
      insert into noelle.linkedin_reply_claims(org_id,activity_urn,approval_id)
      select ${args.orgId},${args.activityUrn},a.id
      from noelle.approvals a
      join noelle.agent_instances ai on ai.id=a.agent_instance_id
      join noelle.drafts d on d.id=a.draft_id
      join noelle.leads l on l.id=d.lead_id
      where a.id=${args.approvalId} and a.org_id=${args.orgId} and d.id=${args.draftId}
        and a.agent_instance_id=${args.instanceId} and ${replyApprovalContextSql(tx)}
        and a.status='pending' and l.platform='linkedin'
        and (ai.reply_send_enabled=true or ai.auto_send_enabled=true)
        and d.sent_external_id is null and d.sent_at is null and d.posted_at is null
        and coalesce(d.payload->>'sent_via','')=''
        and coalesce(d.payload->>'kind','reply')='reply'
        and coalesce(d.payload->>'edited_body',d.payload->>'body','')=${args.body}
        and d.payload=${tx.json(args.draftPayload as JSONValue)}
        and l.payload=${tx.json(args.leadPayload as JSONValue)}
        and ${unattendedReplyReviewSql(tx, tx`d.payload`)}
        and case when jsonb_typeof(d.payload->'verifier_meta'->'scores'->'voice')='number'
          then (d.payload->'verifier_meta'->'scores'->>'voice')::numeric>=${args.voiceFloor} else false end
        and noelle.linkedin_post_activity_urn(l.payload,null)=${args.activityUrn}
        and not exists(select 1 from noelle.linkedin_activity act where act.org_id=${args.orgId}
          and act.type='comment' and act.activity_urn=${args.activityUrn})
        and not exists(select 1 from noelle.approvals sent
          join noelle.drafts sd on sd.id=sent.draft_id and sd.org_id=sent.org_id
          join noelle.leads sl on sl.id=sent.lead_id and sl.id=sd.lead_id and sl.org_id=sent.org_id
          where sent.org_id=${args.orgId} and sent.status='sent' and sl.platform='linkedin'
            and coalesce(sd.payload->>'kind','reply')='reply'
            and noelle.linkedin_post_activity_urn(sl.payload,sl.external_id)=${args.activityUrn})
      on conflict(org_id,activity_urn) do nothing returning activity_urn
    `;
    return inserted.length ? "claimed" : "already-claimed";
  });
}
