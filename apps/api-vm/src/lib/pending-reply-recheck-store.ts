import type { JSONValue, Sql } from "postgres";
import { getRecentRepliesToAuthor, getRecentReplyPhrasings } from "@noelle/runtime";
import type { PendingReplyStore } from "./pending-reply-recheck.js";
import { replyApprovalContextSql } from "./reply-approval-context-sql.js";
import { getPendingReplySnapshotPage } from "./pending-reply-snapshot-db.js";
import { unclaimedPendingReplySql } from "./pending-reply-eligibility-sql.js";


/** Recover existing pending rows, then persist only the same unreserved snapshot. */
export function postgresPendingReplyStore(sql: Sql): PendingReplyStore {
  return {
    list: (orgId, after, through) => getPendingReplySnapshotPage(sql, orgId, after, through),
    async replyHistory(row) {
      const [priorRepliesToPerson,recentReplies] = await Promise.all([
        getRecentRepliesToAuthor(sql,{ agentInstanceId:row.agentInstanceId,authorHandle:row.authorHandle ?? null,
          authorId:row.authorId,excludeLeadId:row.leadId,limit:8 }),
        getRecentReplyPhrasings(sql,{ agentInstanceId:row.agentInstanceId,excludeLeadId:row.leadId,limit:20 }),
      ]);
      return { priorRepliesToPerson,recentReplies };
    },
    async save(row,body,meta,marker) {
      return sql.begin(async tx => {
        await tx`set local lock_timeout='5s'`;
        await tx`set local statement_timeout='10s'`;
        if (!(await tx`select id from noelle.drafts where id=${row.draftId} and org_id=${row.orgId} for update`).length) return false;
        if (!(await tx`select id from noelle.approvals where id=${row.approvalId} and org_id=${row.orgId} for update`).length) return false;
        const saved = await tx<{ id:string }[]>`
          update noelle.drafts d
          set payload=d.payload||${tx.json({ verifier_meta:meta,reply_recheck:marker } as unknown as JSONValue)}
          from noelle.approvals a,noelle.leads l
          where d.id=${row.draftId} and d.lead_id=${row.leadId} and d.org_id=${row.orgId}
            and a.id=${row.approvalId} and a.draft_id=d.id and a.lead_id=l.id and l.id=d.lead_id
            and a.org_id=${row.orgId} and l.org_id=${row.orgId}
            and a.agent_instance_id=${row.agentInstanceId} and l.agent_instance_id=a.agent_instance_id
            and a.status='pending' and l.platform=${row.platform}
            and d.sent_external_id is null and d.sent_at is null and d.posted_at is null
            and coalesce(d.payload->>'sent_via','')='' and coalesce(d.payload->>'kind','reply')='reply'
            and coalesce(d.payload->>'edited_body',d.payload->>'body','')=${body}
            and d.payload=${tx.json(row.draftPayload as JSONValue)}
            and l.payload=${tx.json(row.leadPayload as JSONValue)}
            and l.external_id is not distinct from ${row.leadExternalId}
            and ${replyApprovalContextSql(tx)}
            and ${unclaimedPendingReplySql(tx as unknown as Sql)}
            and not coalesce((d.payload->'verifier_meta'->'pass'='true'::jsonb
              and d.payload->'verifier_meta'->'judgeOk'='true'::jsonb),false)
            and not coalesce((d.payload->'reply_recheck'->'version'=to_jsonb(${marker.version}::integer)
              and d.payload->'reply_recheck'->>'bodySha256'=${marker.bodySha256}
              and d.payload->'reply_recheck'->>'contextSha256'=${marker.contextSha256}
              and d.payload->'verifier_meta'->'judgeOk'='true'::jsonb),false)
          returning d.id
        `;
        return saved.length===1;
      });
    },
  };
}
