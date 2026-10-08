import postgres, { type Sql } from "postgres";
import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { listEnabledFeederSources } from "../lib/x-account-feeder-db.js";
import { runAccountFeederTick, type FeederTickDeps } from "./account-feeder-tick.js";

const url = process.env.NOELLE_FEEDER_READERS_TEST_DATABASE_URL;
describe.skipIf(!url)("X feeder source dispatch (native PostgreSQL)", () => {
  let sql: Sql;
  beforeAll(async () => {
    sql = postgres(url!, { max: 1, onnotice: () => {} });
    if (!String((await sql`select current_database() as name`)[0]?.name).includes("account_feeder_readers_test")) throw new Error("dedicated feeder readers test database required");
    await sql`drop schema if exists noelle cascade`;
    for (const name of ["0001_noelle_schema.sql", "0051_account_feeder.sql"]) {
      await sql.unsafe(await readFile(new URL(`../../../../infra/cloudsql/schema/${name}`, import.meta.url), "utf8"));
    }
  });
  afterAll(async () => { await sql?.end({ timeout: 0 }); });

  it("dispatches the valid source once and never pays for a foreign org source", async () => {
    const orgId = String((await sql`insert into noelle.organizations(slug,name) values ('dispatch_main','Dispatch main') returning id`)[0]!.id);
    const otherOrgId = String((await sql`insert into noelle.organizations(slug,name) values ('dispatch_other','Dispatch other') returning id`)[0]!.id);
    const instanceId = String((await sql`insert into noelle.agent_instances(org_id,role) values (${orgId},'x_intern') returning id`)[0]!.id);
    await sql`insert into noelle.account_feeder_sources(org_id,agent_instance_id,platform,handle)
      values (${orgId},${instanceId},'x','valid'),(${otherOrgId},${instanceId},'x','foreign')`;
    const userTweets = vi.fn(async () => ({ tweets: [], resultCount: 0, resultCountComplete: true }));
    const result = await runAccountFeederTick({
      instance: { id: instanceId, org_id: orgId, status: "active", objective: null },
      sources: await listEnabledFeederSources(sql, instanceId),
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as FeederTickDeps["log"],
      apify: { userTweets, drainRunReceipts: () => [], drainLastRunUsd: () => null },
      extractor: { call: vi.fn(async () => { throw new Error("empty corpus must not be extracted"); }) },
      upsertStylePosts: vi.fn(async () => 0), getCorpus: vi.fn(async () => []),
      upsertUltraProfile: vi.fn(async () => {}), markSourcePulled: vi.fn(async () => {}),
    });
    expect(userTweets).toHaveBeenCalledTimes(1);
    expect(userTweets).toHaveBeenCalledWith(expect.objectContaining({ handle: "valid" }));
    expect(result.sourcesPulled).toBe(1);
  });
});
