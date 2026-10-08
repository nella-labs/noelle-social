import type { Sql } from "postgres";

/** Identifies the original UTC counter charged before a write. Release at most once. */
export interface XApiWriteReservation {
  agentInstanceId: string;
  orgId: string;
  day: string;
}

/** Atomic combined post/reply counter. Manual overrides still charge the counter. */
export async function reserveXApiWrite(
  sql: Sql,
  args: { agentInstanceId: string; orgId: string; cap: number; override?: boolean },
): Promise<XApiWriteReservation | null> {
  const cap = Number.isFinite(args.cap) ? Math.floor(args.cap) : 0;
  if (!args.override && cap < 1) return null;
  const day = new Date().toISOString().slice(0, 10);
  const rows = await sql<Array<{ used: number }>>`
    insert into noelle.x_api_write_budget (agent_instance_id, org_id, day, used)
    select id, org_id, ${day}::date, 1 from noelle.agent_instances
    where id = ${args.agentInstanceId} and org_id = ${args.orgId} and role = 'x_intern'
    on conflict (agent_instance_id, day) do update
      set used = noelle.x_api_write_budget.used + 1
      where noelle.x_api_write_budget.org_id = excluded.org_id
        and (${args.override === true} or noelle.x_api_write_budget.used < ${cap})
    returning used
  `;
  return rows.length > 0 ? { agentInstanceId: args.agentInstanceId, orgId: args.orgId, day } : null;
}

/** Refund only a known rejected or undispatched write against its original day. */
export async function releaseXApiWrite(sql: Sql, reservation: XApiWriteReservation): Promise<void> {
  await sql`
    update noelle.x_api_write_budget
       set used = greatest(0, used - 1)
     where agent_instance_id = ${reservation.agentInstanceId}
       and org_id = ${reservation.orgId} and day = ${reservation.day}::date
  `;
}

export async function getXApiUsedToday(sql: Sql, agentInstanceId: string): Promise<number> {
  const day = new Date().toISOString().slice(0, 10);
  const [row] = await sql<Array<{ used: number }>>`
    select used from noelle.x_api_write_budget
    where agent_instance_id = ${agentInstanceId} and day = ${day}::date
  `;
  return row?.used ?? 0;
}
