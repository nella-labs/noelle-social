import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { sweepApifyTokenHealth } from "./apifyHealthSweep.js";
import { listApifyTokensForHealthSweep, markApifyTokenInvalid, pruneInvalidApifyTokens } from "./apifyPoolDb.js";

export function healthFixture(url: string) {
  const orgId = randomUUID();
  const foreignOrgId = randomUUID();
  const sql = postgres(url, {
    max: 3,
    onnotice: () => {},
    connection: { application_name: "apify-health-native" },
  });
  const setup = async () => {
    const [row] = await sql`select current_database() as name`;
    if (row?.name !== "noelle_apify_health_test") {
      await sql.end({ timeout: 0 });
      throw new Error("Dedicated Apify health test database required");
    }
    await sql`drop schema if exists noelle cascade`;
    for (const name of [
      "0001_noelle_schema.sql", "0033_connections_credentials.sql", "0040_connections_multi_token.sql",
      "0041_connections_token_retry.sql", "0058_connections_in_use.sql",
    ]) {
      await sql.unsafe(await readFile(new URL(`../../../infra/cloudsql/schema/${name}`, import.meta.url), "utf8"));
    }
  };
  const reset = async () => {
    await sql`truncate noelle.organizations cascade`;
    await sql`insert into noelle.organizations(id,slug,name)
      values (${orgId},'one','One'),(${foreignOrgId},'two','Two')`;
  };
  const token = async (secret = "fixture-value") => {
    const id = randomUUID();
    await sql`insert into noelle.connections(id,org_id,kind,label,secret,in_use)
      values (${id},${orgId},'apify','Fixture',${secret},true)`;
    return id;
  };
  const state = async (id: string) => {
    const [row] = await sql`select org_id,kind,active,in_use,invalid_at from noelle.connections where id=${id}`;
    return row;
  };
  const sweep = (
    checkToken: (token: string) => Promise<{ alive: boolean; httpStatus: number }>,
    prune = false,
  ) => sweepApifyTokenHealth({
    sql, orgId, listTokens: listApifyTokensForHealthSweep, checkToken,
    markInvalid: markApifyTokenInvalid,
    ...(prune ? { pruneInvalid: pruneInvalidApifyTokens } : {}),
    concurrency: 3, log: { info: () => {}, warn: () => {} },
  });
  return { sql, orgId, foreignOrgId, setup, reset, token, state, sweep };
}
