import postgres, { type Sql } from "postgres";
import { loadEnv } from "./env.js";

// Singleton postgres.js client for Cloud SQL, mirroring apps/api-vm/src/lib/db.ts.
//
// postgres.js over `pg`: tagged-template queries auto-parameterise (no accidental
// SQL injection from tool args), jsonb round-trips objects natively, and `sql(arr)`
// powers the upsert helpers. We set search_path to `noelle,public` so tool SQL can
// use bare table names, but every query is still schema-qualified (`noelle.foo`)
// for clarity and to be robust to search_path surprises.
//
// Pool is small (max 4): an MCP server serves one operator, effectively serial.

let client: Sql | undefined;

export function getDb(): Sql {
  if (client) return client;
  const env = loadEnv();
  client = postgres(env.NOELLE_DATABASE_URL, {
    max: 4,
    idle_timeout: 30,
    // Bound CONNECTION establishment, not just statement execution. This server
    // is long-lived (the MCP client spawns it once and keeps it for days), so a
    // deploy that restarts Postgres or drops pooled sockets can leave it trying
    // to reconnect. Without a cap, tool calls hang until the client's own
    // multi-minute timeout fires and reports a crashed server. Fail fast.
    connect_timeout: env.NOELLE_MCP_CONNECT_TIMEOUT_S,
    prepare: true,
    connection: {
      search_path: "noelle,public",
      statement_timeout: env.NOELLE_MCP_STATEMENT_TIMEOUT_MS,
    },
  });
  return client;
}

export async function closeDb(): Promise<void> {
  if (client) {
    await client.end({ timeout: 5 });
    client = undefined;
  }
}

// Test escape hatches, matching the api-vm convention.
export function __setDbClientForTests(stub: Sql) {
  client = stub;
}
export function resetDbClientForTests() {
  client = undefined;
}
