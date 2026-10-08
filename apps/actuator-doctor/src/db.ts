import postgres, { type Sql } from "postgres";
import { loadEnv } from "./env.js";

// postgres.js singleton (copied from apps/reddit-intern/src/lib/db.ts). The
// doctor is read-mostly: probe queries (stuck queue, skip spikes, arm state) and
// exactly one MUTATION — the fail-closed kill switch (remediate.ts). A short
// connect_timeout means an unreachable/invalid DB fails a probe fast instead of
// hanging a tick (the smoke boot points this at postgres://invalid on purpose).

let client: Sql | undefined;

export function noelleDb(): Sql {
  if (client) return client;
  const env = loadEnv();
  client = postgres(env.NOELLE_DATABASE_URL, {
    max: 3,
    idle_timeout: 20,
    connect_timeout: 10,
    prepare: true,
    onnotice: () => {},
  });
  return client;
}

export function resetDbClientForTests() {
  client = undefined;
}

export function __setDbClientForTests(stub: Sql) {
  client = stub;
}
