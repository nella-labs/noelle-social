import type { Sql } from "postgres";
import { z } from "zod";
import { BoundedPgSession, PgOperationError } from "./boundedPgSession.js";
import { CAP_EXEMPT_ENGINES_APIFY_XAPI, resolveBudgetPeriod, type BudgetPeriod } from "./pgBudgetAdapters.js";
import { SPEND_COST_BASES, type SpendCostBasis } from "./spendRecorder.js";

export type BudgetHoldsCursor = { admittedAt: string; id: string };
export type BudgetHold = {
  id: string; instanceId: string | null; agentRole: string; worker: string;
  engine: string; model: string; bucket: string; admittedAt: string; estimatedCents: number;
  pot: "common" | "codex" | "infrastructure";
  receipt: { id: string; status: string; cents: number; costBasis: SpendCostBasis; startedAt: string } | null;
  recordedPeriodCents: number;
  heldCapacityCents: number;
};
export type BudgetHoldsPage = {
  period: BudgetPeriod; periodStartedAt: string; holds: BudgetHold[]; nextCursor: BudgetHoldsCursor | null;
};
type Row = {
  id: string; agent_instance_id: string | null; agent_role: string; worker: string;
  engine: string; model: string; bucket: string; admitted_at: string; estimated_cents: number;
  receipt_id: string | null; receipt_status: string | null; receipt_cents: number | null;
  receipt_basis: SpendCostBasis; receipt_started_at: string | null; current_cents: number;
};
const cursorSchema = z.object({
  id: z.string().uuid(),
  admittedAt: z.string().max(64).regex(/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}(?::?\d{2})?)$/)
    .refine((value) => Number.isFinite(Date.parse(value))),
}).strict();
const sessions = new WeakMap<Sql, BoundedPgSession>();

/** Read unresolved capacity with coherent receipts; this owner never releases or expires an admission. */
export async function readPgBudgetHolds(parent: Sql, args: {
  orgId: string; instanceId?: string; limit?: number; cursor?: BudgetHoldsCursor; period?: BudgetPeriod;
}): Promise<BudgetHoldsPage> {
  const cursor = args.cursor === undefined ? null : cursorSchema.safeParse(args.cursor);
  if (cursor && !cursor.success) throw new Error("Invalid budget hold cursor");
  const after = cursor?.success ? cursor.data : null;
  const limit = typeof args.limit === "number" && Number.isFinite(args.limit)
    ? Math.max(1, Math.min(100, Math.floor(args.limit))) : 50;
  const period = resolveBudgetPeriod(args.period);
  let session = sessions.get(parent);
  if (!session) {
    session = new BoundedPgSession(parent, { deadlineMs: 2500, maxPending: 32, idleTimeoutMs: 1000 });
    sessions.set(parent, session);
  }
  return session.run(async (sql) => {
    const [context] = await sql<{ period_started_at: string }[]>`
      select date_trunc(${period}, statement_timestamp())::text as period_started_at
      from noelle.organizations o where o.id=${args.orgId}
        and (${args.instanceId ?? null}::uuid is null or exists (select 1 from noelle.agent_instances ai
          where ai.id=${args.instanceId ?? null} and ai.org_id=o.id))
    `;
    if (!context) throw new PgOperationError("database");
    // Text parameters preserve microseconds through the driver's timestamp serialization.
    const rows = await sql<Row[]>`
      select r.id, r.agent_instance_id, r.agent_role, r.worker, r.engine, r.model, r.bucket,
        r.admitted_at::text as admitted_at, r.estimated_cents,
        c.id as receipt_id, c.status as receipt_status, c.cents as receipt_cents,
        coalesce(to_jsonb(c)->>'cost_basis','unknown') as receipt_basis, c.started_at::text as receipt_started_at,
        case when c.started_at >= ${context.period_started_at}::text::timestamptz then c.cents else 0 end as current_cents
      from noelle.llm_budget_reservations r
      left join noelle.llm_calls c on c.attempt_id=r.id and c.org_id=r.org_id
        and c.agent_instance_id is not distinct from r.agent_instance_id and c.agent_role=r.agent_role
        and c.worker=r.worker and c.engine=r.engine and c.model=r.model and c.bucket=r.bucket
      where r.org_id=${args.orgId} and r.settled_at is null
        and (${args.instanceId ?? null}::uuid is null or r.agent_instance_id=${args.instanceId ?? null})
        and (${after?.admittedAt ?? null}::text::timestamptz is null or
          (r.admitted_at,r.id) < (${after?.admittedAt ?? null}::text::timestamptz,${after?.id ?? null}::uuid))
      order by r.admitted_at desc,r.id desc limit ${limit + 1}
    `;
    const holds = rows.slice(0, limit).map((r): BudgetHold => ({
      id: r.id, instanceId: r.agent_instance_id, agentRole: r.agent_role, worker: r.worker,
      engine: r.engine, model: r.model, bucket: r.bucket, admittedAt: r.admitted_at, estimatedCents: Number(r.estimated_cents),
      pot: r.engine === "codex-cli" ? "codex" : CAP_EXEMPT_ENGINES_APIFY_XAPI.some((engine) => engine === r.engine) ? "infrastructure" : "common",
      receipt: r.receipt_id ? { id: r.receipt_id, status: r.receipt_status!, cents: Number(r.receipt_cents),
        costBasis: SPEND_COST_BASES.includes(r.receipt_basis) ? r.receipt_basis : "unknown", startedAt: r.receipt_started_at! } : null,
      recordedPeriodCents: Number(r.current_cents),
      heldCapacityCents: Math.max(Number(r.estimated_cents) - Number(r.current_cents), 0),
    }));
    const last = holds.at(-1);
    return { period, periodStartedAt: context.period_started_at, holds,
      nextCursor: rows.length > limit && last ? { admittedAt: last.admittedAt, id: last.id } : null };
  });
}
