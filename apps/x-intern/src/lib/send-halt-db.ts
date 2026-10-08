import type { Sql } from "postgres";
import { BoundedPgSession } from "@noelle/runtime/bounded-pg-session";

const sessions = new WeakMap<Sql, BoundedPgSession>();
function sessionFor(parent: Sql): BoundedPgSession {
  let session = sessions.get(parent);
  if (!session) {
    session = new BoundedPgSession(parent, {
      deadlineMs: 3000,
      maxPending: 32,
      idleTimeoutMs: 1000,
    });
    sessions.set(parent, session);
  }
  return session;
}

/** Acknowledges only a committed halt of the current tenant's eligible X parent. */
export async function haltXSend(
  parent: Sql,
  scope: { orgId: string; instanceId: string },
): Promise<boolean> {
  return sessionFor(parent).run((sql) =>
    sql.begin(async (tx) => {
      await tx`set local lock_timeout='1s'`;
      await tx`set local statement_timeout='2s'`;
      await tx`set local idle_in_transaction_session_timeout='3s'`;
      const rows = await tx<{ id: string }[]>`update noelle.agent_instances set send_enabled=false
      where id=${scope.instanceId} and org_id=${scope.orgId} and role='x_intern'
        and status in ('active','paused') returning id`;
      return rows.length === 1;
    }),
  );
}
