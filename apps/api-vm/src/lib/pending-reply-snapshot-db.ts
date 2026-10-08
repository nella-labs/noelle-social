import type { Sql } from "postgres";
import type { PersistedModelOverrides } from "@noelle/runtime";
import { PENDING_REPLY_PAGE_SIZE, type PendingReplyCursor } from "./pending-reply-pagination.js";
import { unclaimedPendingReplySql } from "./pending-reply-eligibility-sql.js";

import { replyApprovalContextSql } from "./reply-approval-context-sql.js";

type JsonObject = Record<string, unknown>;

/** One page of tenant-consistent, unreserved reply snapshots in exact creation order. */
export async function getPendingReplySnapshotPage(sql: Sql, orgId: string, after?: PendingReplyCursor, through?: Date) {
  // Text-bound cursors preserve PostgreSQL microseconds across the driver boundary.
  const rows = await sql<Array<{
    approval_id:string; approval_created_at:string; draft_id:string; lead_id:string;
    agent_instance_id:string; org_id:string; platform:"linkedin"|"x";
    draft_payload:JsonObject; lead_payload:JsonObject; external_id:string;
    author_handle:string|null; author_id:string|null; model_overrides:PersistedModelOverrides|null;
  }>>`
    select a.id as approval_id,
           to_char(a.created_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as approval_created_at,
           d.id as draft_id,l.id as lead_id,a.agent_instance_id,a.org_id,l.platform,l.external_id,
           d.payload as draft_payload,l.payload as lead_payload,l.author_handle,l.author_id,ai.model_overrides
    from noelle.approvals a
    join noelle.drafts d on d.id = a.draft_id and d.org_id = a.org_id
    join noelle.leads l on l.id = a.lead_id and l.id = d.lead_id
      and l.org_id = a.org_id and l.agent_instance_id = a.agent_instance_id
    join noelle.agent_instances ai on ai.id = a.agent_instance_id and ai.org_id = a.org_id
    where a.org_id = ${orgId} and a.status = 'pending'
      and ${replyApprovalContextSql(sql)}
      and d.sent_external_id is null and d.sent_at is null and d.posted_at is null
      and coalesce(d.payload->>'sent_via', '') = ''
      and coalesce(d.payload->>'kind', 'reply') = 'reply' and l.platform in ('linkedin', 'x')
      and ${unclaimedPendingReplySql(sql)}
      and (${through ?? null}::timestamptz is null or a.created_at <= ${through ?? null})
      and (${after?.approvalCreatedAt ?? null}::text is null
        or (a.created_at,a.id) > ((${after?.approvalCreatedAt ?? null}::text)::timestamptz,${after?.approvalId ?? null}::uuid))
    order by a.created_at asc,a.id asc limit ${PENDING_REPLY_PAGE_SIZE}
  `;
  return rows.map(row => ({
    approvalId:row.approval_id,approvalCreatedAt:row.approval_created_at,
    draftId:row.draft_id,leadId:row.lead_id,leadExternalId:row.external_id,
    agentInstanceId:row.agent_instance_id,orgId:row.org_id,platform:row.platform,
    modelOverrides:row.model_overrides,draftPayload:row.draft_payload,leadPayload:row.lead_payload,
    authorHandle:row.author_handle,authorId:row.author_id,
  }));
}
