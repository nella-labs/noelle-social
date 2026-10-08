import type { JSONValue, Sql } from "postgres";
import type {
  PendingReplyReconcileStore,
} from "./pending-reply-reconcile.js";
import { replyApprovalContextSql } from "./reply-approval-context-sql.js";
import { getPendingReplySnapshotPage } from "./pending-reply-snapshot-db.js";
import { unclaimedPendingReplySql } from "./pending-reply-eligibility-sql.js";

/** Every read and write is scoped through approval, draft, lead, tenant, and instance. */
export function postgresPendingReplyReconcileStore(sql: Sql): PendingReplyReconcileStore {
  return {
    list: (orgId, after, through) => getPendingReplySnapshotPage(sql, orgId, after, through),

    async skip(row, reason, decidedAt) {
      return sql.begin(async tx => {
        await tx`set local lock_timeout = '5s'`;
        await tx`set local statement_timeout = '10s'`;
        if (!(await tx`select id from noelle.drafts where id=${row.draftId} and org_id=${row.orgId} for update`).length) return false;
        if (!(await tx`select id from noelle.approvals where id=${row.approvalId} and org_id=${row.orgId} for update`).length) return false;
        const saved = await tx<Array<{ id: string }>>`
          update noelle.approvals a
          set status = 'skipped',
              decided_at = ${decidedAt}::timestamptz,
              decided_by = 'automatic-review',
              skip_reason = ${reason}
          from noelle.drafts d, noelle.leads l
          where a.id = ${row.approvalId}
            and a.org_id = ${row.orgId}
            and a.agent_instance_id = ${row.agentInstanceId}
            and a.status = 'pending'
            and a.draft_id = ${row.draftId} and a.lead_id = ${row.leadId}
            and d.id = a.draft_id and d.lead_id = a.lead_id
            and d.org_id = a.org_id
            and l.id = a.lead_id and l.id = d.lead_id
            and l.org_id = a.org_id
            and l.agent_instance_id = a.agent_instance_id
            and l.platform = ${row.platform}
            and coalesce(d.payload->>'kind', 'reply') = 'reply'
            and d.sent_external_id is null
            and d.sent_at is null and d.posted_at is null
            and coalesce(d.payload->>'sent_via', '') = ''
            and d.payload = ${tx.json(row.draftPayload as JSONValue)}
            and l.payload = ${tx.json(row.leadPayload as JSONValue)}
            and l.external_id is not distinct from ${row.leadExternalId}
            and ${replyApprovalContextSql(tx)}
            and ${unclaimedPendingReplySql(tx as unknown as Sql)}
          returning a.id
        `;
        return saved.length === 1;
      });
    },
  };
}
