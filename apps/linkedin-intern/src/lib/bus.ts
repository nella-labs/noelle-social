import { createBus, type Bus, type QueryExecutor } from "@noelle/runtime";
import { noelleDb } from "./db.js";
import type { ActiveInstance } from "./activation.js";

/**
 * Shared-memory bus for the LinkedIn Growth Intern (Lyra). Same seam as the X
 * intern's lib/bus.ts: bind the postgres.js singleton to the runtime's
 * QueryExecutor, then scope a Bus to one agent instance. Built per tick.
 *
 * Writes are fail-soft (see packages/runtime/src/bus.ts), so calling these from
 * inside a worker tick can never break the draft-only pipeline.
 */

const AGENT_ROLE = "linkedin_intern";

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
