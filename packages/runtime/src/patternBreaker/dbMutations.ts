import { randomUUID } from "node:crypto";
import type { JSONValue, Sql, TransactionSql } from "postgres";
import { PatternFindingSchema, UuidSchema, type PatternFinding } from "@noelle/contracts";
import {
  lockPatternOwner,
  patternSession,
  validPatternScope,
  type PatternScope,
} from "./dbContext.js";
import {
  lockCapturedCorpus,
  patternCorpusSql,
  validCapturedCorpus,
  validFindingEvidence,
  type RecentPost,
} from "./dbCorpus.js";
import {
  admittedAlertSql,
  admittedRuleSql,
  coherentAlertSources,
  refiningFields,
  scopedRuleJoin,
  type RefiningAlertRow,
  type PatternRefineClaim,
} from "./dbReads.js";

export interface PersistPatternArgs extends PatternScope {
  finding: PatternFinding;
  windowSize: number;
  corpus: RecentPost[];
}
/** New observations never overwrite a standing manual/refined rule or duplicate its alert. */
export async function persistPattern(
  parent: Sql,
  args: PersistPatternArgs,
): Promise<{ ruleId: string; alertId: string } | null> {
  if (
    !validPatternScope(args) ||
    !validCapturedCorpus(args.corpus) ||
    !validFindingEvidence(args.finding, args.corpus, args.windowSize)
  )
    return null;
  return patternSession(parent).run((sql) =>
    sql.begin(async (tx) => {
      if (!(await lockPatternOwner(tx, args)) || !(await lockCapturedCorpus(tx, args, args.corpus)))
        return null;
      const f = PatternFindingSchema.parse(args.finding);
      const [rule] = await tx<{ id: string }[]>`
      insert into noelle.pattern_rules(org_id,agent_instance_id,kind,label,instruction,suggestion,regex,severity,active,source)
      values(${args.orgId},${args.agentInstanceId},${f.kind},${f.label},${f.instruction},${f.suggestion ?? null},
        ${f.regex ?? null},${f.severity},true,'auto')
      on conflict(agent_instance_id,lower(label)) where active do nothing returning id`;
      if (!rule) return null;
      const [alert] = await tx<{ id: string }[]>`
      insert into noelle.pattern_alerts(org_id,agent_instance_id,rule_id,pattern_name,description,severity,
        window_size,frequency_count,examples,status)
      values(${args.orgId},${args.agentInstanceId},${rule.id},${f.label},${f.description},${f.severity},
        ${args.windowSize},${f.frequencyCount},${tx.json(f.examples as unknown as JSONValue)},'open') returning id`;
      return { ruleId: rule.id, alertId: alert!.id };
    }),
  );
}

async function capturedAlertSources(
  tx: TransactionSql,
  scope: PatternScope,
  item: RefiningAlertRow,
): Promise<RecentPost[] | null> {
  const ids = [
    ...new Set(item.examples.flatMap((e) => (e.draftId ? [e.draftId.toLowerCase()] : []))),
  ];
  if (!ids.length) return [];
  if (ids.some((id) => !UuidSchema.safeParse(id).success)) return null;
  const rows = await tx<
    { draft_id: string; body: string; kind: "reply" | "post"; platform: string }[]
  >`
    select draft_id,body,kind,platform from (${patternCorpusSql(tx, scope)}) corpus where draft_id=any(${ids}::uuid[])`;
  // Ambiguous IDs in different source tables cannot provide a unique captured example.
  if (rows.length !== ids.length) return null;
  const posts = rows.map((r) => ({
    draftId: r.draft_id,
    body: r.body,
    kind: r.kind,
    platform: r.platform,
  }));
  return (await lockCapturedCorpus(tx, scope, posts)) ? posts : null;
}
async function lockedRefiningRow(
  tx: TransactionSql,
  scope: PatternScope,
  id: string,
): Promise<RefiningAlertRow | null> {
  const [rule] = await tx<{ id: string }[]>`
    select r.id from noelle.pattern_rules r join noelle.pattern_alerts a on ${scopedRuleJoin(tx)}
    where a.id=${id} and a.org_id=${scope.orgId} and a.agent_instance_id=${scope.agentInstanceId}
      and a.status='refining' and r.active order by r.id for no key update of r`;
  if (!rule) return null;
  const [row] = await tx<RefiningAlertRow[]>`
    select ${refiningFields(tx)} from noelle.pattern_alerts a join noelle.pattern_rules r on ${scopedRuleJoin(tx)}
    where a.id=${id} and a.org_id=${scope.orgId} and a.agent_instance_id=${scope.agentInstanceId}
      and a.status='refining' and r.active and ${admittedRuleSql(tx)}
      and ${admittedAlertSql(tx)} and ${coherentAlertSources(tx, scope)} for no key update of a`;
  return row ?? null;
}
function sameRequest(a: RefiningAlertRow, b: RefiningAlertRow): boolean {
  return (
    a.alert_id === b.alert_id &&
    a.rule_id === b.rule_id &&
    a.rule_updated_at === b.rule_updated_at &&
    a.rule_snapshot === b.rule_snapshot &&
    a.current_instruction === b.current_instruction &&
    a.pattern_name === b.pattern_name &&
    a.description === b.description &&
    a.refine_note === b.refine_note &&
    a.refine_request_id === b.refine_request_id &&
    JSON.stringify(a.examples) === JSON.stringify(b.examples)
  );
}
export interface CapturedPatternClaim extends PatternRefineClaim {
  sourcePosts: RecentPost[];
}
/** One durable, current request claim immediately before one external model dispatch. */
export async function claimRefinement(
  parent: Sql,
  scope: PatternScope,
  item: RefiningAlertRow,
): Promise<CapturedPatternClaim | null> {
  if (!validPatternScope(scope) || !UuidSchema.safeParse(item.alert_id).success) return null;
  return patternSession(parent).run((sql) =>
    sql.begin(async (tx) => {
      if (!(await lockPatternOwner(tx, scope))) return null;
      // Sources precede rule/alert locks, matching observation persistence and operator writers.
      const sourcePosts = await capturedAlertSources(tx, scope, item);
      if (sourcePosts === null) return null;
      const current = await lockedRefiningRow(tx, scope, item.alert_id);
      if (!current || !sameRequest(current, item)) return null;
      const requestId = current.refine_request_id ?? randomUUID();
      const claimId = randomUUID();
      const rows = await tx`update noelle.pattern_alerts
      set refine_request_id=${requestId},refine_claim_id=${claimId}
      where id=${item.alert_id} and org_id=${scope.orgId} and agent_instance_id=${scope.agentInstanceId}
        and status='refining' and refine_claim_id is null returning id`;
      return rows.length
        ? { ...current, refine_request_id: requestId, refine_claim_id: claimId, sourcePosts }
        : null;
    }),
  );
}
/** Only the captured request/claim, sources and unchanged live rule may accept the result. */
export async function applyRefinedRule(
  parent: Sql,
  scope: PatternScope,
  args: {
    claim: CapturedPatternClaim;
    instruction: string | null;
    decidedBy: string;
  },
): Promise<boolean> {
  if (!validPatternScope(scope)) return false;
  const admitted = PatternFindingSchema.shape.instruction.safeParse(args.instruction?.trim());
  return patternSession(parent).run((sql) =>
    sql.begin(async (tx) => {
      if (!(await lockPatternOwner(tx, scope))) return false;
      if (
        args.claim.sourcePosts.length &&
        !(await lockCapturedCorpus(tx, scope, args.claim.sourcePosts))
      )
        return false;
      const current = await lockedRefiningRow(tx, scope, args.claim.alert_id);
      if (!current || !sameRequest(current, args.claim)) return false;
      const [claimed] = await tx`select id from noelle.pattern_alerts
      where id=${args.claim.alert_id} and refine_request_id=${args.claim.refine_request_id}
        and refine_claim_id=${args.claim.refine_claim_id} for no key update`;
      if (!claimed) return false;
      if (!admitted.success || admitted.data === current.current_instruction.trim()) {
        await tx`update noelle.pattern_alerts set status='open',decided_at=now(),decided_by=${args.decidedBy}
        where id=${args.claim.alert_id}`;
        return false;
      }
      await tx`update noelle.pattern_rules set instruction=${admitted.data},source='refined',updated_at=clock_timestamp()
      where id=${args.claim.rule_id} and org_id=${scope.orgId} and agent_instance_id=${scope.agentInstanceId}`;
      await tx`update noelle.pattern_alerts set status='refined',decided_at=now(),decided_by=${args.decidedBy}
      where id=${args.claim.alert_id}`;
      return true;
    }),
  );
}

/** Same scoped rule/alert mutation policy for the API and dashboard transaction owners. */
export async function mutatePatternAlertInTx(
  tx: TransactionSql,
  scope: PatternScope,
  args: {
    alertId: string;
    action: "refine" | "revert" | "acknowledge";
    note?: string;
    expectedRequestId?: string;
    decidedBy: string;
  },
): Promise<{ status: string; requestId: string | null } | null> {
  if (
    !validPatternScope(scope) ||
    !UuidSchema.safeParse(args.alertId).success ||
    (args.note !== undefined && (typeof args.note !== "string" || args.note.length > 600)) ||
    (args.expectedRequestId !== undefined && !UuidSchema.safeParse(args.expectedRequestId).success)
  )
    return null;
  if (!(await lockPatternOwner(tx, scope))) return null;
  if (args.action === "refine") {
    const [candidate] = await tx<RefiningAlertRow[]>`
      select ${refiningFields(tx)} from noelle.pattern_alerts a join noelle.pattern_rules r on ${scopedRuleJoin(tx)}
      where a.id=${args.alertId} and a.org_id=${scope.orgId} and a.agent_instance_id=${scope.agentInstanceId}
        and a.status in ('open','refined','refining') and r.active
        and ${admittedRuleSql(tx)} and ${admittedAlertSql(tx)} and ${coherentAlertSources(tx, scope)}`;
    if (!candidate || (await capturedAlertSources(tx, scope, candidate)) === null) return null;
  }
  const [rule] = await tx<{ id: string }[]>`
    select r.id from noelle.pattern_rules r join noelle.pattern_alerts a on ${scopedRuleJoin(tx)}
    where a.id=${args.alertId} and a.org_id=${scope.orgId} and a.agent_instance_id=${scope.agentInstanceId}
    order by r.id for no key update of r`;
  const [alert] = await tx<
    {
      rule_id: string | null;
      status: string;
      refine_request_id: string | null;
      refine_claim_id: string | null;
    }[]
  >`
    select rule_id,status,refine_request_id,refine_claim_id from noelle.pattern_alerts
    where id=${args.alertId} and org_id=${scope.orgId} and agent_instance_id=${scope.agentInstanceId} for no key update`;
  if (!alert || (alert.rule_id !== null && !rule)) return null;
  if (args.action === "refine") {
    if (!rule || !["open", "refined", "refining"].includes(alert.status)) return null;
    if (args.expectedRequestId !== undefined) {
      if (alert.refine_request_id !== args.expectedRequestId.toLowerCase()) return null;
    } else if (
      alert.status === "refining" ||
      (alert.status === "open" && alert.refine_claim_id !== null)
    )
      return null;
    const requestId = randomUUID();
    await tx`update noelle.pattern_alerts set status='refining',refine_note=${args.note ?? null},
      refine_request_id=${requestId},refine_claim_id=null,decided_at=now(),decided_by=${args.decidedBy}
      where id=${args.alertId}`;
    return { status: "refining", requestId };
  }
  if (!["open", "refined", "refining"].includes(alert.status)) return null;
  const status = args.action === "revert" ? "reverted" : "acknowledged";
  if (args.action === "revert" && rule) {
    await tx`update noelle.pattern_rules set active=false,updated_at=clock_timestamp() where id=${rule.id}`;
  }
  await tx`update noelle.pattern_alerts set status=${status},decided_at=now(),decided_by=${args.decidedBy}
    where id=${args.alertId}`;
  return { status, requestId: alert.refine_request_id };
}
export function mutatePatternAlert(
  parent: Sql,
  scope: PatternScope,
  args: Parameters<typeof mutatePatternAlertInTx>[2],
) {
  return patternSession(parent).run((sql) =>
    sql.begin((tx) => mutatePatternAlertInTx(tx, scope, args)),
  );
}
export async function setPatternRuleActiveInTx(
  tx: TransactionSql,
  scope: PatternScope,
  ruleId: string,
  active: boolean,
): Promise<boolean> {
  if (
    !validPatternScope(scope) ||
    !UuidSchema.safeParse(ruleId).success ||
    !(await lockPatternOwner(tx, scope))
  )
    return false;
  const rows =
    await tx`update noelle.pattern_rules set active=${active},updated_at=clock_timestamp()
    where id=${ruleId} and org_id=${scope.orgId} and agent_instance_id=${scope.agentInstanceId} returning id`;
  if (!rows.length) return false;
  await tx`update noelle.pattern_alerts set status=${active ? "acknowledged" : "reverted"},decided_at=now(),decided_by=${scope.userId ?? null}
    where rule_id=${ruleId} and org_id=${scope.orgId} and agent_instance_id=${scope.agentInstanceId}`;
  return true;
}
