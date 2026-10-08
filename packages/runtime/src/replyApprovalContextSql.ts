import type { Sql, TransactionSql } from "postgres";

/** Aliases a/d/l must identify one approval, its draft, and its native lead. */
export function replyApprovalContextSql(sql: Sql | TransactionSql) {
  return sql.unsafe(`d.id=a.draft_id and d.lead_id=a.lead_id and d.org_id=a.org_id
    and l.id=a.lead_id and l.org_id=a.org_id and l.agent_instance_id=a.agent_instance_id
    and exists(select 1 from noelle.agent_instances owner where owner.id=a.agent_instance_id
      and owner.org_id=a.org_id and owner.role=l.platform||'_intern')`);
}
