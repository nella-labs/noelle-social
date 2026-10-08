import type { Sql } from "postgres";
import { BoundedPgSession } from "./boundedPgSession.js";

const sessions = new WeakMap<Sql, BoundedPgSession>();

/** Shared native Video SQL resource; generation and extraction remain outside it. */
export function withVideoDb<T>(parent: Sql, operation: (sql: Sql) => Promise<T>): Promise<T> {
  let session = sessions.get(parent);
  if (!session) {
    session = new BoundedPgSession(parent, { deadlineMs: 8000, maxPending: 16, idleTimeoutMs: 1000 });
    sessions.set(parent, session);
  }
  return session.run(operation);
}

/** Acquire the current Video/org parent before source reads or mutations. */
export function withVideoOwner<T>(parent: Sql, instanceId: string, orgId: string,
  operation: (sql: Sql) => Promise<T>, rejected: T): Promise<T> {
  return withVideoDb(parent, async sql => await sql.begin(async tx => {
    const owners = await tx`select id from noelle.agent_instances
      where id=${instanceId} and org_id=${orgId} and role='video_intern' for share`;
    return owners.length === 1 ? operation(tx as unknown as Sql) : rejected;
  }) as T);
}
