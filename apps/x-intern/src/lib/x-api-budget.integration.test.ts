import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import postgres from "postgres";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { reserveXApiWrite, releaseXApiWrite } from "./x-api-budget.js";

const url = process.env.NOELLE_X_API_BUDGET_TEST_DATABASE_URL;
const org = "00000000-0000-4000-8000-000000000001";
const otherOrg = "00000000-0000-4000-8000-000000000002";
const instance = "00000000-0000-4000-8000-000000000011";
const day = "2026-10-05";

describe.skipIf(!url)("shared X API write budget (dedicated PostgreSQL)", () => {
  let sql: ReturnType<typeof postgres>;
  beforeAll(async () => {
    sql = postgres(url!, { max: 8, onnotice: () => {} });
    const db = (await sql<{ db: string }[]>`select current_database() as db`)[0]?.db;
    if (!db?.endsWith("_x_api_budget_test")) throw new Error(`refusing to reset non-dedicated database ${db}`);
    await sql`drop schema if exists noelle cascade`;
    for (const file of ["0001_noelle_schema.sql", "0075_x_api_write.sql"])
      await sql.unsafe(readFileSync(resolve("../../infra/cloudsql/schema", file), "utf8"));
  });
  beforeEach(async () => {
    await sql`truncate noelle.x_api_write_budget, noelle.agent_instances, noelle.organizations cascade`;
    await sql`insert into noelle.organizations (id,slug,name) values (${org},'one','One'),(${otherOrg},'two','Two')`;
    await sql`insert into noelle.agent_instances (id,org_id,role) values (${instance},${org},'x_intern')`;
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(`${day}T23:59:59Z`));
  });
  afterEach(() => vi.useRealTimers());
  afterAll(async () => { await sql?.end(); });

  it("bounds concurrent reservations and returns the original day", async () => {
    const reservations = await Promise.all(Array.from({ length: 8 }, () =>
      reserveXApiWrite(sql, { orgId: org, agentInstanceId: instance, cap: 3 })));
    expect(reservations.filter(Boolean)).toHaveLength(3);
    expect(reservations.find(Boolean)).toEqual({ orgId: org, agentInstanceId: instance, day });
    expect((await sql<{ used: number }[]>`select used from noelle.x_api_write_budget`)[0]?.used).toBe(3);
  });

  it("refunds the original reservation day after midnight without decrementing the next day", async () => {
    await reserveXApiWrite(sql, { orgId: org, agentInstanceId: instance, cap: 3 });
    vi.setSystemTime(new Date("2026-10-06T00:00:01Z"));
    await reserveXApiWrite(sql, { orgId: org, agentInstanceId: instance, cap: 3 });
    await releaseXApiWrite(sql, { orgId: org, agentInstanceId: instance, day } as never);
    expect(await sql`select day::text as day, used from noelle.x_api_write_budget order by day`).toEqual([
      { day, used: 0 }, { day: "2026-10-06", used: 1 },
    ]);
  });

  it("records a deliberate manual override while refusing an automatic write beyond its cap", async () => {
    await reserveXApiWrite(sql, { orgId: org, agentInstanceId: instance, cap: 1 });
    expect(await reserveXApiWrite(sql, { orgId: org, agentInstanceId: instance, cap: 1 })).toBeNull();
    expect(await reserveXApiWrite(sql, { orgId: org, agentInstanceId: instance, cap: 1, override: true }))
      .toEqual({ orgId: org, agentInstanceId: instance, day });
    expect((await sql<{ used: number }[]>`select used from noelle.x_api_write_budget`)[0]?.used).toBe(2);
  });

  it("does not reserve or refund another organization's instance", async () => {
    await reserveXApiWrite(sql, { orgId: org, agentInstanceId: instance, cap: 3 });
    expect(await reserveXApiWrite(sql, { orgId: otherOrg, agentInstanceId: instance, cap: 3 })).toBeNull();
    await releaseXApiWrite(sql, { orgId: otherOrg, agentInstanceId: instance, day } as never);
    expect((await sql<{ used: number }[]>`select used from noelle.x_api_write_budget`)[0]?.used).toBe(1);
  });
});
