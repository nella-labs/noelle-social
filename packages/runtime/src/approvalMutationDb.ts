import type { Sql, TransactionSql } from "postgres";
import { replyApprovalContextSql } from "./replyApprovalContextSql.js";

export class ApprovalMutationError extends Error {
  constructor(
    readonly category:
      | "approval_changed"
      | "already_actioned"
      | "automatic_review_rejected"
      | "send_already_claimed"
      | "not_a_dm",
  ) {
    super(
      category === "automatic_review_rejected"
        ? "Approval was rejected by automatic review and cannot be restored."
        : category,
    );
  }
}
export type ApprovalMutationScope = { orgId: string; approvalId: string; operatorId: string };
type Candidate = {
  id: string;
  draft_id: string;
  lead_id: string | null;
  agent_instance_id: string;
  kind: string;
};
type LockedApproval = Candidate & {
  status: string;
  decided_by: string | null;
  receipt: string | null;
  sent_at: Date | null;
  posted_at: Date | null;
  approvalIds: string[];
  draftIds: string[];
};

function contextSql(tx: TransactionSql) {
  return tx`(${replyApprovalContextSql(tx)} or
    (a.lead_id is null and d.lead_id is null and d.id=a.draft_id and d.org_id=a.org_id
      and d.payload->>'kind'='dm' and exists(select 1 from noelle.agent_instances owner
        where owner.id=a.agent_instance_id and owner.org_id=a.org_id
          and owner.role in ('x_intern','linkedin_intern','reddit_intern'))))`;
}

async function setBounds(tx: TransactionSql) {
  await tx`set local lock_timeout='5s'`;
  await tx`set local statement_timeout='10s'`;
  await tx`set local idle_in_transaction_session_timeout='20s'`;
}

/** Native parent authority, then the draft → approval → lead order used by dispatch. */
async function lockApproval(
  tx: TransactionSql,
  scope: ApprovalMutationScope,
): Promise<LockedApproval | null> {
  const [candidate] = await tx<Candidate[]>`select a.id,a.draft_id,a.lead_id,a.agent_instance_id,
    coalesce(d.payload->>'kind','reply') as kind from noelle.approvals a
    join noelle.drafts d on d.id=a.draft_id left join noelle.leads l on l.id=a.lead_id
    where a.id=${scope.approvalId} and a.org_id=${scope.orgId}
      and coalesce(d.payload->>'kind','reply') in ('reply','dm') and ${contextSql(tx)} limit 1`;
  if (!candidate) return null;
  if (
    !(
      await tx`select id from noelle.agent_instances where id=${candidate.agent_instance_id}
    and org_id=${scope.orgId} for no key update`
    ).length
  )
    return null;
  const related =
    candidate.kind === "dm"
      ? [candidate]
      : await tx<Candidate[]>`
    select a.id,a.draft_id,a.lead_id,a.agent_instance_id,coalesce(d.payload->>'kind','reply') as kind
    from noelle.approvals a join noelle.drafts d on d.id=a.draft_id left join noelle.leads l on l.id=a.lead_id
    where a.org_id=${scope.orgId} and a.agent_instance_id=${candidate.agent_instance_id}
      and a.lead_id=${candidate.lead_id} and coalesce(d.payload->>'kind','reply')='reply' and ${contextSql(tx)}`;
  const draftIds = related.map((row) => row.draft_id);
  const approvalIds = related.map((row) => row.id);
  await tx`select id from noelle.drafts where org_id=${scope.orgId} and id=any(${draftIds}::uuid[]) order by id for update`;
  await tx`select id from noelle.approvals where org_id=${scope.orgId} and id=any(${approvalIds}::uuid[]) order by id for update`;
  if (candidate.lead_id)
    await tx`select id from noelle.leads where id=${candidate.lead_id}
    and org_id=${scope.orgId} and agent_instance_id=${candidate.agent_instance_id} for no key update`;
  const [row] = await tx<Omit<LockedApproval, "approvalIds" | "draftIds">[]>`
    select a.id,a.draft_id,a.lead_id,a.agent_instance_id,a.status,a.decided_by,
      coalesce(d.payload->>'kind','reply') as kind,d.sent_external_id as receipt,d.sent_at,d.posted_at
    from noelle.approvals a join noelle.drafts d on d.id=a.draft_id left join noelle.leads l on l.id=a.lead_id
    where a.id=${candidate.id} and a.org_id=${scope.orgId} and a.draft_id=${candidate.draft_id}
      and a.agent_instance_id=${candidate.agent_instance_id} and a.lead_id is not distinct from ${candidate.lead_id}::uuid
      and coalesce(d.payload->>'kind','reply')=${candidate.kind} and ${contextSql(tx)}`;
  return row ? { ...row, approvalIds, draftIds } : null;
}

async function assertNoWrite(
  tx: TransactionSql,
  scope: ApprovalMutationScope,
  row: LockedApproval,
) {
  const [barrier] = await tx`select 1 where
    exists(select 1 from noelle.drafts where org_id=${scope.orgId} and id=any(${row.draftIds}::uuid[])
      and (sent_external_id is not null or sent_at is not null or posted_at is not null))
    or exists(select 1 from noelle.x_reply_claims where org_id=${scope.orgId} and approval_id=any(${row.approvalIds}::uuid[]))
    or exists(select 1 from noelle.linkedin_reply_claims where org_id=${scope.orgId} and approval_id=any(${row.approvalIds}::uuid[]))
    or exists(select 1 from noelle.reddit_reply_claims where org_id=${scope.orgId} and approval_id=any(${row.approvalIds}::uuid[]))`;
  if (barrier) throw new ApprovalMutationError("send_already_claimed");
}

async function withApproval<T>(
  sql: Sql,
  scope: ApprovalMutationScope,
  write: (tx: TransactionSql, row: LockedApproval) => Promise<T>,
): Promise<T> {
  return sql.begin(async (tx) => {
    await setBounds(tx);
    const row = await lockApproval(tx, scope);
    if (!row) throw new ApprovalMutationError("approval_changed");
    return write(tx, row);
  }) as Promise<T>;
}

async function skipLocked(
  tx: TransactionSql,
  scope: ApprovalMutationScope,
  row: LockedApproval,
  reason: string | null,
  options: { selectedPendingOnly?: boolean } = {},
) {
  if (options.selectedPendingOnly && row.status !== "pending")
    return { approvalId: row.id, count: 0 };
  if (row.status === "skipped") return { approvalId: row.id, count: 0 };
  if (!["pending", "deferred", "errored"].includes(row.status))
    throw new ApprovalMutationError("already_actioned");
  await assertNoWrite(tx, scope, row);
  const approvalIds = options.selectedPendingOnly ? [row.id] : row.approvalIds;
  const statuses = options.selectedPendingOnly ? ["pending"] : ["pending", "deferred", "errored"];
  const changed = await tx<
    { id: string }[]
  >`update noelle.approvals a set status='skipped',decided_at=now(),
    decided_by=${scope.operatorId},skip_reason=${reason} from noelle.drafts d left join noelle.leads l on l.id=d.lead_id
    where a.id=any(${approvalIds}::uuid[]) and a.org_id=${scope.orgId} and a.status=any(${statuses}::text[])
      and d.id=a.draft_id and ${contextSql(tx)} returning a.id`;
  return { approvalId: row.id, count: changed.length };
}

export function skipApproval(
  sql: Sql,
  scope: ApprovalMutationScope,
  reason: string | null = null,
  options: { selectedPendingOnly?: boolean } = {},
) {
  return withApproval(sql, scope, (tx, row) =>
    skipLocked(tx, scope, row, reason, options),
  );
}

export function restoreSkippedApproval(sql: Sql, scope: ApprovalMutationScope) {
  return withApproval(sql, scope, async (tx, row) => {
    if (row.status === "pending") return { approvalId: row.id, count: 0 };
    if (row.status !== "skipped") throw new ApprovalMutationError("already_actioned");
    if (row.decided_by === "automatic-review")
      throw new ApprovalMutationError("automatic_review_rejected");
    await assertNoWrite(tx, scope, row);
    const changed = await tx<
      { id: string }[]
    >`update noelle.approvals a set status='pending',decided_at=null,decided_by=null,skip_reason=null
      from noelle.drafts d left join noelle.leads l on l.id=d.lead_id
      where a.id=any(${row.approvalIds}::uuid[]) and a.org_id=${scope.orgId} and a.status='skipped'
        and a.decided_by is distinct from 'automatic-review' and d.id=a.draft_id and ${contextSql(tx)} returning a.id`;
    return { approvalId: row.id, count: changed.length };
  });
}

export function parkApprovalDm(sql: Sql, scope: ApprovalMutationScope) {
  return withApproval(sql, scope, async (tx, row) => {
    if (row.kind !== "dm") throw new ApprovalMutationError("not_a_dm");
    if (row.status === "deferred") return { approvalId: row.id };
    if (!["pending", "errored"].includes(row.status))
      throw new ApprovalMutationError("already_actioned");
    await assertNoWrite(tx, scope, row);
    await tx`update noelle.approvals set status='deferred',decided_at=now(),decided_by=${scope.operatorId}
      where id=${row.id} and org_id=${scope.orgId}`;
    return { approvalId: row.id };
  });
}

export function saveApprovalEdit(sql: Sql, scope: ApprovalMutationScope, body: string) {
  return withApproval(sql, scope, async (tx, row) => {
    if (!["pending", "deferred"].includes(row.status))
      throw new ApprovalMutationError("already_actioned");
    await assertNoWrite(tx, scope, row);
    await tx`update noelle.drafts set payload=(case when coalesce(payload->>'edited_body',payload->>'body','')=${body}
      then coalesce(payload,'{}'::jsonb) else coalesce(payload,'{}'::jsonb)-'verifier_meta'-'reply_recheck' end)
      ||${tx.json({ edited_body: body, edited: true })} where id=${row.draft_id} and org_id=${scope.orgId}`;
    return { approvalId: row.id, draftId: row.draft_id };
  });
}

export async function bulkSkipApprovals(
  sql: Sql,
  args: { orgId: string; approvalIds: string[]; operatorId: string; reason?: string },
) {
  return sql.begin(async (tx) => {
    await setBounds(tx);
    const selected = await tx<
      Candidate[]
    >`select distinct on (a.agent_instance_id,a.lead_id) a.id,a.draft_id,a.lead_id,a.agent_instance_id,
      coalesce(d.payload->>'kind','reply') as kind from noelle.approvals a
      join noelle.drafts d on d.id=a.draft_id left join noelle.leads l on l.id=a.lead_id
      where a.org_id=${args.orgId} and a.id=any(${args.approvalIds}::uuid[]) and a.status='pending'
        and coalesce(d.payload->>'kind','reply')='reply' and ${contextSql(tx)} order by a.agent_instance_id,a.lead_id,a.id`;
    let approvals = 0;
    let leads = 0;
    for (const candidate of selected) {
      const scope = { orgId: args.orgId, approvalId: candidate.id, operatorId: args.operatorId };
      const row = await lockApproval(tx, scope);
      if (!row || row.status !== "pending") continue;
      const result = await skipLocked(tx, scope, row, args.reason ?? "bulk-skip");
      approvals += result.count;
      if (result.count) leads++;
    }
    return { approvals, leads };
  });
}
