import type { Sql, TransactionSql } from "postgres";
import { unattendedReplyReviewSql } from "./unattendedReplyReviewSql.js";
import { sourceTimestampSql } from "./sourceTimestampSql.js";
import { xReplyAgeCutoffSql } from "./xReplyFreshnessSql.js";
import { containsExternalLink } from "./linkPolicy.js";

export interface XReplyClaim {
  orgId: string;
  draftId: string;
  targetTweetId: string;
  approvalId: string;
}

type XReplyClaimArgs = { orgId: string; draftId: string; targetTweetId: string } & (
  | { mode: "manual" | "worker" }
  | { mode: "browser"; approvalId: string; body: string; maxAgeHours: number; blockExternalLinks: boolean }
);

/** Reserve immediately before dispatch; success and uncertain writes retain this claim. */
export async function reserveXReplyClaim(
  sql: Sql,
  args: XReplyClaimArgs,
): Promise<XReplyClaim | null> {
  return sql.begin((tx) => reserveXReplyClaimInTransaction(tx, args));
}

/** The caller may already hold an organization quota lock in this transaction. */
export async function reserveXReplyClaimInTransaction(
  tx: TransactionSql,
  args: XReplyClaimArgs,
): Promise<XReplyClaim | null> {
    if (args.mode === "browser" && (!args.body.trim() ||
      (args.blockExternalLinks && containsExternalLink(args.body)))) return null;
    await tx`set local lock_timeout = '5s'`;
    await tx`set local statement_timeout = '10s'`;
    const drafts = await tx<{ id: string }[]>`
      select id from noelle.drafts where id=${args.draftId} and org_id=${args.orgId} for update
    `;
    if (!drafts[0]) return null;
    await tx`
      select id from noelle.approvals where draft_id=${args.draftId} and org_id=${args.orgId} order by id for update
    `;
    // Eligibility is read after the locks, so a committing edit or decision
    // cannot leave dispatch using its earlier snapshot.
    const rows = await tx<{ approval_id: string }[]>`
    insert into noelle.x_reply_claims (org_id, tweet_id, approval_id)
    select a.org_id, l.external_id, a.id
    from noelle.approvals a
    join noelle.agent_instances ai on ai.id = a.agent_instance_id and ai.org_id = a.org_id
    join noelle.drafts d on d.id = a.draft_id and d.org_id = a.org_id
    join noelle.leads l on l.id = d.lead_id and l.id = a.lead_id and l.org_id = a.org_id
    where a.org_id = ${args.orgId} and d.id = ${args.draftId}
      and ai.role = 'x_intern' and l.platform = 'x'
      and l.agent_instance_id = ai.id
      and l.external_id = ${args.targetTweetId} and l.external_id ~ '^[0-9]+$'
      and coalesce(d.payload->>'kind', 'reply') = 'reply'
      and d.sent_external_id is null and d.sent_at is null
      and (
        (${args.mode} = 'manual' and a.status in ('pending', 'deferred', 'errored'))
        or (${args.mode} = 'worker' and a.status = 'sent'
          and (a.decided_by is distinct from 'auto-send' or ${unattendedReplyReviewSql(tx, tx`d.payload`)}))
        or (${args.mode === "browser" ? tx`a.id=${args.approvalId} and a.status='pending'
          and a.auto_send_target_at is null and (ai.reply_send_enabled or ai.auto_send_enabled)
          and ${unattendedReplyReviewSql(tx, tx`d.payload`)}
          and btrim(coalesce(d.payload->>'edited_body', d.payload->>'body', ''))=${args.body}
          and (${args.maxAgeHours} <= 0
            or (l.payload->>'source'='extension_observed' and l.payload->'classifier'->>'judge'='jev')
            or ${sourceTimestampSql(tx, tx`l.payload->>'posted_at'`)} is null
            or ${sourceTimestampSql(tx, tx`l.payload->>'posted_at'`)} >= ${xReplyAgeCutoffSql(tx, tx`l.payload`, args.maxAgeHours)})`
          : tx`false`})
      )
      and not exists (
        select 1 from noelle.x_activity activity
        where activity.org_id = a.org_id and activity.tweet_id = l.external_id
          and activity.type in ('reply', 'skip')
      )
      and not exists (
        select 1 from noelle.approvals sent
        join noelle.drafts sent_draft on sent_draft.id = sent.draft_id and sent_draft.org_id = a.org_id
        join noelle.leads sent_lead on sent_lead.id = sent.lead_id and sent_lead.org_id = a.org_id
        where sent.org_id = a.org_id and sent.id <> a.id and sent.status = 'sent'
          and sent_lead.platform = 'x' and sent_lead.external_id = l.external_id
          and coalesce(sent_draft.payload->>'kind', 'reply') = 'reply'
          and (${args.mode === "browser"} or sent_draft.sent_external_id is not null or sent_draft.sent_at is not null)
      )
    on conflict (org_id, tweet_id) do nothing
    returning approval_id
  `;
    return rows[0]
    ? {
        orgId: args.orgId,
        draftId: args.draftId,
        targetTweetId: args.targetTweetId,
        approvalId: rows[0].approval_id,
      }
    : null;
}

/** Only a known rejection or failure before dispatch permits release. */
export async function releaseXReplyClaim(sql: Sql, claim: XReplyClaim): Promise<boolean> {
  const [row] = await sql<{ released: boolean }[]>`
    select noelle.release_x_reply_claim(${claim.orgId}::uuid, ${claim.targetTweetId}, ${claim.approvalId}::uuid) as released
  `;
  return row?.released === true;
}
