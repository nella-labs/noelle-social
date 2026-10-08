import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import postgres from "postgres";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { saveApifyUsage } from "@noelle/runtime/apify-usage-db";
import { readApifySpendData } from "./apify-spend-db";
import { apifyTokenSpend, summarizeApifyProviderSpend } from "./apify-spend-model";

const url = process.env.NOELLE_TEST_DATABASE_URL;
const orgId = "00000000-0000-4000-8000-000000000001";
const otherOrgId = "00000000-0000-4000-8000-000000000002";
const oldId = "00000000-0000-4000-8000-000000000003";
const newId = "00000000-0000-4000-8000-000000000004";
const otherId = "00000000-0000-4000-8000-000000000005";
const cycleStartAt = "2026-08-30T00:00:00.000Z";
const cycleEndAt = "2026-09-29T23:59:59.999Z";

describe.skipIf(!url)("Apify expense reads (integration)", () => {
  let sql: ReturnType<typeof postgres>;
  beforeAll(async () => {
    sql = postgres(url!, { max: 1, onnotice: () => {} });
    const [row] = await sql<{ db: string }[]>`select current_database() as db`;
    if (!row?.db.includes("test")) throw new Error("Apify expense tests require a test database");
    await sql.unsafe("do $$ begin create role noelle_app nologin; exception when duplicate_object then null; end $$");
  });
  beforeEach(async () => {
    await sql`begin`;
    await sql`create schema noelle`;
    await sql`create table noelle.organizations (id uuid primary key)`;
    await sql`create table noelle.connections (
      id uuid primary key, org_id uuid not null references noelle.organizations(id),
      kind text not null, label text not null, secret text not null default 'test-token',
      active boolean not null default true, in_use boolean not null default true,
      invalid_at timestamptz, updated_at timestamptz default now()
    )`;
    await sql`create table noelle.llm_calls (
      id bigserial primary key, org_id uuid not null references noelle.organizations(id),
      credential_id uuid references noelle.connections(id) on delete set null,
      engine text not null, started_at timestamptz not null, cents integer not null
    )`;
    const schemaDir = resolve(process.cwd(), "../../infra/cloudsql/schema");
    const migration = readdirSync(schemaDir).find((name) => name.startsWith("0104_"));
    if (!migration) throw new Error("Apify usage migration 0104 is missing");
    await sql.unsafe(readFileSync(resolve(schemaDir, migration), "utf8"));
    await sql`insert into noelle.organizations (id) values (${orgId}), (${otherOrgId})`;
    await sql`insert into noelle.connections (id, org_id, kind, label) values
      (${oldId}, ${orgId}, 'apify', 'retired-token'),
      (${newId}, ${orgId}, 'apify', 'current-token'),
      (${otherId}, ${otherOrgId}, 'apify', 'private-other-tenant')`;
  });
  afterEach(async () => { await sql`rollback`; });
  afterAll(async () => { await sql?.end(); });

  it("keeps retired identity and provider daily costs while isolating other tenants", async () => {
    const health = {
      alive: true, httpStatus: 200, accountId: "shared-account", cycleStartAt, cycleEndAt,
      monthlyUsageUsd: 2.51,
      dailyUsage: [{ date: "2026-08-31", usageUsd: 0.5 }, { date: "2026-09-01", usageUsd: 2.01 }],
    };
    await saveApifyUsage(sql, orgId, oldId, health);
    await saveApifyUsage(sql, otherOrgId, otherId, { ...health, accountId: "other-account", monthlyUsageUsd: 99 });
    await sql`update noelle.connections set active = false, in_use = false, invalid_at = now()
      where id = ${oldId}`;
    await sql`insert into noelle.llm_calls (org_id, credential_id, engine, started_at, cents) values
      (${orgId}, ${oldId}, 'apify', '2026-09-01T10:00:00Z', 1000),
      (${orgId}, null, 'apify', '2026-09-02T10:00:00Z', 23),
      (${orgId}, null, 'codex-cli', '2026-09-02T10:00:00Z', 500),
      (${otherOrgId}, ${otherId}, 'apify', '2026-09-01T10:00:00Z', 9000)`;

    const { snapshots, ledger } = await readApifySpendData(sql, orgId);
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]).toMatchObject({
      credentialId: oldId, label: "retired-token", active: false,
      accountId: "shared-account", usageUsd: 2.51, cycleStartAt, cycleEndAt,
    });
    expect(snapshots[0]?.dailyUsage.map((day) => ({ ...day, date: day.date.slice(0, 10) }))).toEqual([
      { date: "2026-08-31", usageUsd: 0.5 }, { date: "2026-09-01", usageUsd: 2.01 },
    ]);
    expect(ledger).toHaveLength(2);
    expect(ledger).toEqual(expect.arrayContaining([
      expect.objectContaining({ credentialId: oldId, label: "retired-token", active: false, day: "2026-09-01", cents: 1000 }),
      expect.objectContaining({ credentialId: null, day: "2026-09-02", cents: 23 }),
    ]));
    expect(summarizeApifyProviderSpend(snapshots, ledger, "2026-09-01T00:00:00Z")).toMatchObject({
      cents: expect.closeTo(201, 8), unverifiedCents: 23,
    });
  });

  it("counts duplicate account credentials once using the latest provider correction", async () => {
    const health = {
      alive: true, httpStatus: 200, accountId: "shared-account", cycleStartAt, cycleEndAt,
      monthlyUsageUsd: 2.51, dailyUsage: [{ date: "2026-09-01", usageUsd: 2.51 }],
    };
    await saveApifyUsage(sql, orgId, oldId, health);
    await saveApifyUsage(sql, orgId, newId, {
      ...health, monthlyUsageUsd: 1.75, dailyUsage: [{ date: "2026-09-01", usageUsd: 1.75 }],
    });
    await sql`update noelle.apify_usage_snapshots
      set fetched_at = case when credential_id = ${oldId}
        then '2026-09-17T12:00:00Z'::timestamptz else '2026-09-17T13:00:00Z'::timestamptz end
      where org_id = ${orgId}`;
    const { snapshots, ledger } = await readApifySpendData(sql, orgId);
    expect(snapshots).toHaveLength(2);
    expect(summarizeApifyProviderSpend(snapshots, ledger, null).cents).toBe(175);
    expect(apifyTokenSpend(snapshots, ledger).filter((token) => token.source === "provider")
      .map((token) => token.cents)).toEqual([175, 175]);
  });

  it("retains the saved provider expense when every later probe returns 401", async () => {
    await saveApifyUsage(sql, orgId, oldId, {
      alive: true, httpStatus: 200, accountId: "dead-account", cycleStartAt, cycleEndAt,
      monthlyUsageUsd: 3.125, dailyUsage: [{ date: "2026-09-17", usageUsd: 3.125 }],
    });
    const before = await readApifySpendData(sql, orgId);
    for (let probe = 0; probe < 3; probe += 1) {
      await saveApifyUsage(sql, orgId, oldId, { alive: false, httpStatus: 401, monthlyUsageUsd: 0 });
    }
    const after = await readApifySpendData(sql, orgId);
    expect(after).toEqual(before);
    expect(summarizeApifyProviderSpend(after.snapshots, after.ledger, null).cents).toBe(312.5);
  });

  it("keeps previous billing cycles when the current provider balance resets to zero", async () => {
    const health = {
      alive: true, httpStatus: 200, accountId: "reset-account", cycleStartAt, cycleEndAt,
      monthlyUsageUsd: 2.51, dailyUsage: [{ date: "2026-09-01", usageUsd: 2.51 }],
    };
    await saveApifyUsage(sql, orgId, oldId, health);
    await saveApifyUsage(sql, orgId, oldId, {
      ...health, monthlyUsageUsd: 0, dailyUsage: [],
      cycleStartAt: "2026-09-30T00:00:00.000Z", cycleEndAt: "2026-10-29T23:59:59.999Z",
    });
    const { snapshots, ledger } = await readApifySpendData(sql, orgId);
    expect(snapshots).toHaveLength(2);
    expect(summarizeApifyProviderSpend(snapshots, ledger, "2026-09-01T00:00:00Z").cents).toBeCloseTo(251);
    expect(apifyTokenSpend(snapshots, ledger)).toEqual([
      expect.objectContaining({ credentialId: oldId, cents: 0, source: "provider" }),
    ]);
  });
});
