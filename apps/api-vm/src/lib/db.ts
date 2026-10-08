import postgres, { type Sql } from "postgres";
import { loadEnv } from "../env.js";

// Singleton `postgres` (postgres.js) client for Cloud SQL.
//
// Why postgres.js over node-postgres (`pg`):
//   - Template-literal tagged queries (`sql`...``) auto-parameterise, so we
//     can't accidentally interpolate user input as SQL.
//   - Native helpers for jsonb (objects round-trip without manual JSON.stringify)
//     and for `sql(arr)` row-list inserts, which matches the upsert patterns
//     this service uses.
//   - Smaller surface, no separate pool/client distinction.
//
// Pool sizing: the api-vm runs on a single VM (noelle-vm-0). At p99 we have
// ~3 concurrent requests; `max: 5` leaves headroom without sitting on Cloud
// SQL connection slots. Cloud SQL `db-custom-1-3840` defaults to ~100 max,
// shared with apps/app + worker pools — being a polite tenant matters.
//
// `idle_timeout: 30` (seconds) reaps idle sockets so we don't hold the
// connection across the long quiet periods between drafter batches.
//
// `prepare: true` — the default, but called out: every query in this service
// is a fixed-shape template, so prepared statements give us the parse-plan
// cache for free.

let client: Sql | undefined;

export function noelleDb(): Sql {
  if (client) return client;
  const env = loadEnv();
  client = postgres(env.NOELLE_DATABASE_URL, {
    max: 5,
    idle_timeout: 30,
    prepare: true,
  });
  return client;
}

// Test escape hatches. The outbound/drafts tests swap in a stub that mimics
// just the tagged-template + helper shapes we use. resetDbClientForTests
// drops the memoization so subsequent loadEnv()/noelleDb() picks the swap up.
export function resetDbClientForTests() {
  client = undefined;
}

export function __setDbClientForTests(stub: Sql) {
  client = stub;
}
