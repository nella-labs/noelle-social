import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { saveApifyUsage } from "./apifyUsageDb.js";
import type { ApifyAccountUsageHealth } from "./apifyUsage.js";

const url = process.env.NOELLE_TEST_DATABASE_URL ?? process.env.APIFY_USAGE_TEST_DATABASE_URL;
const orgId = "00000000-0000-4000-8000-000000000101";
const credentialId = "00000000-0000-4000-8000-000000000201";
const otherCredentialId = "00000000-0000-4000-8000-000000000202";
const usage: ApifyAccountUsageHealth = {
  alive: true, httpStatus: 200, accountId: "usr_abc123", monthlyUsageUsd: 12.345678,
  maxMonthlyUsageUsd: 100, remainingUsd: 87.654322,
  cycleStartAt: "2026-09-01T00:00:00.000Z", cycleEndAt: "2026-10-01T00:00:00.000Z",
  dailyUsage: [{ date: "2026-09-01", usageUsd: 0 }, { date: "2026-09-02", usageUsd: 2.005 }],
  fetchedAt: "2026-09-17T12:00:00.000Z",
};

describe.skipIf(!url)("saveApifyUsage (integration)", () => {
  let sql: ReturnType<typeof postgres>;
  beforeAll(async () => {
    sql = postgres(url!, { max: 4, onnotice: () => {} });
    const [row] = await sql<{ db: string }[]>`select current_database() as db`;
    if (!row?.db.includes("test")) throw new Error("Apify usage tests require a test database");
    await sql`drop schema if exists noelle cascade`;
    await sql`create schema noelle`;
    await sql.unsafe("do $$ begin create role noelle_app nologin; exception when duplicate_object then null; end $$");
    await sql`create table noelle.organizations (id uuid primary key)`;
    await sql`insert into noelle.organizations values (${orgId})`;
    await sql`create table noelle.connections (
      id uuid primary key, org_id uuid not null, kind text not null default 'apify', label text not null
    )`;
    await sql.unsafe(readFileSync(resolve(dirname(fileURLToPath(import.meta.url)),
      "../../../infra/cloudsql/schema/0104_apify_usage.sql"), "utf8"));
  });
  beforeEach(async () => {
    await sql`truncate noelle.apify_usage_snapshots`;
    await sql`truncate noelle.connections`;
    await sql`insert into noelle.connections (id, org_id, label) values
      (${credentialId}, ${orgId}, 'apify_...live'), (${otherCredentialId}, ${orgId}, 'apify_...new')`;
  });
  afterAll(async () => { await sql?.end(); });

  it("stores exact provider USD, daily JSONB and a label from the scoped connection", async () => {
    expect(await saveApifyUsage(sql, orgId, credentialId, usage)).toMatchObject({ saved: true });
    const [row] = await sql`select credential_id, label, account_id, usage_usd::text,
      max_usage_usd::text, remaining_usd::text, fetched_at, daily_usage
      from noelle.apify_usage_snapshots where credential_id = ${credentialId}`;
    expect(row).toMatchObject({ credential_id: credentialId, label: "apify_...live",
      account_id: "usr_abc123", usage_usd: "12.345678", max_usage_usd: "100",
      remaining_usd: "87.654322", daily_usage: usage.dailyUsage });
    expect(row?.fetched_at.toISOString()).toBe("2026-09-17T12:00:00.000Z");
  });

  it("keeps same-account snapshots separate for different credential rows", async () => {
    await saveApifyUsage(sql, orgId, credentialId, usage);
    await saveApifyUsage(sql, orgId, otherCredentialId, {
      ...usage, monthlyUsageUsd: 13, fetchedAt: "2026-09-17T14:00:00Z",
    });
    expect(await sql`select credential_id, label, account_id, usage_usd::text
      from noelle.apify_usage_snapshots order by credential_id`).toEqual([
      { credential_id: credentialId, label: "apify_...live", account_id: "usr_abc123", usage_usd: "12.345678" },
      { credential_id: otherCredentialId, label: "apify_...new", account_id: "usr_abc123", usage_usd: "13" },
    ]);
  });

  it("keeps the newest correction when writes race and rejects a later-arriving stale probe", async () => {
    await Promise.all([
      saveApifyUsage(sql, orgId, credentialId, { ...usage, monthlyUsageUsd: 99 }),
      saveApifyUsage(sql, orgId, credentialId, {
        ...usage, monthlyUsageUsd: 11.5, fetchedAt: "2026-09-17T13:00:00Z",
      }),
    ]);
    expect(await saveApifyUsage(sql, orgId, credentialId, usage)).toEqual({ saved: false, reason: "stale_fetch" });
    expect(await sql`select usage_usd::text from noelle.apify_usage_snapshots`).toEqual([{ usage_usd: "11.5" }]);
  });

  it("retains a previous cycle while accepting a real zero balance in the next cycle", async () => {
    await saveApifyUsage(sql, orgId, credentialId, usage);
    expect(await saveApifyUsage(sql, orgId, credentialId, {
      ...usage, monthlyUsageUsd: 0, dailyUsage: [],
      cycleStartAt: "2026-10-01T00:00:00Z", cycleEndAt: "2026-11-01T00:00:00Z",
      fetchedAt: "2026-10-01T00:00:01Z",
    })).toMatchObject({ saved: true });
    expect(await sql`select to_char(cycle_start_at at time zone 'UTC', 'YYYY-MM-DD') as cycle, usage_usd::text as usd
      from noelle.apify_usage_snapshots order by cycle_start_at`).toEqual([
      { cycle: "2026-09-01", usd: "12.345678" }, { cycle: "2026-10-01", usd: "0" },
    ]);
  });

  it("does not replace the last successful reading after a token starts returning 401", async () => {
    await saveApifyUsage(sql, orgId, credentialId, usage);
    const before = await sql`select * from noelle.apify_usage_snapshots`;
    expect(await saveApifyUsage(sql, orgId, credentialId, { alive: false, httpStatus: 401 }, {
      fetchedAt: new Date("2026-09-17T13:00:00Z"),
    })).toEqual({ saved: false, reason: "not_alive" });
    expect(await sql`select * from noelle.apify_usage_snapshots`).toEqual(before);
  });

  it("rejects missing account/daily data and credentials outside the organization", async () => {
    const { accountId: _account, ...missingAccount } = usage;
    const { dailyUsage: _daily, ...missingDaily } = usage;
    for (const health of [missingAccount, missingDaily]) {
      expect(await saveApifyUsage(sql, orgId, credentialId, health)).toEqual({ saved: false, reason: "invalid_usage" });
    }
    expect(await saveApifyUsage(sql, "00000000-0000-4000-8000-000000000199", credentialId, usage))
      .toEqual({ saved: false, reason: "missing_connection" });
    expect(await sql`select count(*)::int as n from noelle.apify_usage_snapshots`).toEqual([{ n: 0 }]);
  });
});
