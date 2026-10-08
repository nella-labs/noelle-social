import postgres, { type Sql } from "postgres";
import { loadEnv } from "../env.js";

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

export function resetDbClientForTests() {
  client = undefined;
}

export function __setDbClientForTests(stub: Sql) {
  client = stub;
}
