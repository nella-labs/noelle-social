import { randomUUID } from "node:crypto";
import type { Sql } from "postgres";
import { BudgetExceededError, type BudgetAttempt } from "./budgetBucket.js";
import { BoundedPgSession, PgOperationError } from "./boundedPgSession.js";

type Options = { period: "month" | "week"; exempt: string[]; deadlineMs: number };
type Gate = { bucket: number; org: number; instance: number; engine: number; instance_cap: number | null; org_cap: number; paused: boolean };
const sessions = new WeakMap<Sql, BoundedPgSession>();

/** Serialize each tenant's estimated admissions without holding a lock during provider work. */
export async function reservePgBudgetAttempt(parent: Sql, options: Options, args: BudgetAttempt): Promise<{ attemptId: string }> {
  if (!Number.isSafeInteger(args.estimatedCents) || args.estimatedCents < 0 || args.estimatedCents > 2_147_483_647) {
    throw new PgOperationError("database");
  }
  if (args.engineCapCents !== undefined && (!Number.isSafeInteger(args.engineCapCents) || args.engineCapCents < 0)) {
    throw new PgOperationError("database");
  }
  let session = sessions.get(parent);
  if (!session) {
    session = new BoundedPgSession(parent, { deadlineMs: options.deadlineMs, maxPending: 32, idleTimeoutMs: 1000 });
    sessions.set(parent, session);
  }
  const attemptId = randomUUID();
  const result = await session.run((sql) => sql.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(hashtextextended('llm-budget:' || ${args.orgId}::uuid::text, 0))`;
    const rows = await tx<Gate[]>`
      with charges as (
        select c.bucket, c.agent_instance_id, c.engine, c.cents::bigint as cents
        from noelle.llm_calls c
        where c.org_id = ${args.orgId} and c.started_at >= date_trunc(${options.period}, statement_timestamp())
        union all
        select r.bucket, r.agent_instance_id, r.engine,
          greatest(r.estimated_cents - coalesce(c.cents, 0), 0)::bigint
        from noelle.llm_budget_reservations r
        left join noelle.llm_calls c on c.attempt_id = r.id
          and c.org_id = r.org_id and c.agent_instance_id is not distinct from r.agent_instance_id
          and c.started_at >= date_trunc(${options.period}, statement_timestamp())
        where r.org_id = ${args.orgId} and r.settled_at is null
      ), totals as (
        select coalesce(sum(cents) filter (where engine not in (select jsonb_array_elements_text(${tx.json(options.exempt)}::jsonb)) and bucket = ${args.bucket}), 0)::bigint as bucket,
          coalesce(sum(cents) filter (where engine not in (select jsonb_array_elements_text(${tx.json(options.exempt)}::jsonb))), 0)::bigint as org,
          coalesce(sum(cents) filter (where engine not in (select jsonb_array_elements_text(${tx.json(options.exempt)}::jsonb)) and agent_instance_id = ${args.instanceId}), 0)::bigint as instance,
          coalesce(sum(cents) filter (where engine = ${args.engine}), 0)::bigint as engine
        from charges
      )
      select totals.*, ai.budget_cap_cents as instance_cap,
        (select coalesce(sum(budget_cap_cents),0)::bigint from noelle.agent_instances where org_id = ai.org_id) as org_cap,
        coalesce((to_jsonb(o)->>'budget_cap_paused_until')::timestamptz > statement_timestamp(), false) as paused
      from totals, noelle.agent_instances ai
      join noelle.organizations o on o.id = ai.org_id
      where ai.id = ${args.instanceId} and ai.org_id = ${args.orgId}
    `;
    const gate = rows[0];
    if (!gate) throw new PgOperationError("database");
    const orgCap = Number(gate.org_cap) > 0 ? Number(gate.org_cap) : Number.MAX_SAFE_INTEGER;
    const checks = [
      { layer: "bucket" as const, spent: Number(gate.bucket), cap: orgCap },
      { layer: "org" as const, spent: Number(gate.org), cap: orgCap },
      { layer: "instance" as const, spent: Number(gate.instance), cap: gate.instance_cap === null ? Number.MAX_SAFE_INTEGER : Number(gate.instance_cap) },
    ];
    if (!options.exempt.includes(args.engine) && !gate.paused) {
      for (const check of checks) {
        if (check.spent + args.estimatedCents > check.cap) return { blocked: { ...check, estimated: args.estimatedCents } };
      }
    }
    if (args.engineCapCents !== undefined && Number(gate.engine) + args.estimatedCents > args.engineCapCents) {
      return { blocked: { layer: "bucket" as const, spent: Number(gate.engine), cap: args.engineCapCents, estimated: args.estimatedCents } };
    }
    await tx`
      insert into noelle.llm_budget_reservations
        (id, org_id, agent_instance_id, agent_role, worker, engine, model, bucket, estimated_cents)
      values (${attemptId}, ${args.orgId}, ${args.instanceId}, ${args.agentRole}, ${args.worker}, ${args.engine}, ${args.model}, ${args.bucket}, ${args.estimatedCents})
    `;
    return { attemptId };
  }));
  if ("blocked" in result && result.blocked) {
    const b = result.blocked;
    throw new BudgetExceededError({ layer: b.layer, spent_cents: b.spent, cap_cents: b.cap, estimated_cents: b.estimated });
  }
  return { attemptId };
}
