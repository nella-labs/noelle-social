import { createBus, type Bus, type QueryExecutor } from "@noelle/runtime";
import { noelleDb } from "./db.js";
import type { ActiveInstance } from "./activation.js";

/**
 * Shared-memory bus for the X Growth Intern (Vega). Binds the postgres.js
 * singleton to the driver-agnostic QueryExecutor the runtime client consumes
 * (same seam as apps/api-vm/src/lib/auth.ts), then scopes a Bus to one agent
 * instance. Built fresh per tick — it's just a closure over the pooled sql.
 *
 * Writes are fail-soft (see packages/runtime/src/bus.ts), so calling these from
 * inside a worker tick can never break the pipeline.
 */

const AGENT_ROLE = "x_intern";

function execFromDb(): QueryExecutor {
  const sql = noelleDb();
  return async (query, params) => {
    const rows = await sql.unsafe(query, params as never[]);
    return rows as unknown as ReadonlyArray<Record<string, unknown>>;
  };
}

export function busForInstance(inst: ActiveInstance): Bus {
  return createBus({
    exec: execFromDb(),
    orgId: inst.org_id,
    agentInstanceId: inst.id,
    agentRole: AGENT_ROLE,
  });
}
