import postgres, { type Sql } from "postgres";
import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { readPgBudgetHolds } from "./pgBudgetHolds.js";

const url = process.env.NOELLE_BUDGET_HOLDS_TEST_DATABASE_URL;
describe.skipIf(!url)("budget hold visibility (native PostgreSQL)", () => {
  let sql: Sql, org: string, foreignOrg: string, instance: string, sibling: string, foreignInstance: string;
  beforeAll(async () => {
    sql = postgres(url!, { max: 3, onnotice: () => {} });
    if ((await sql`select current_database() as name`)[0]?.name !== "noelle_budget_holds_test") {
      throw Error("dedicated budget holds database required");
    }
    await sql`drop schema if exists noelle cascade`;
    for (const name of ["0001_noelle_schema.sql", "0014_llm_calls_agent_instance_id.sql", "0033_connections_credentials.sql", "0116_llm_budget_reservations.sql", "0117_llm_cost_basis.sql"]) {
      await sql.unsafe(await readFile(new URL(`../../../infra/cloudsql/schema/${name}`, import.meta.url), "utf8"));
    }
  });
  beforeEach(async () => {
    await sql`truncate noelle.organizations cascade`;
    [org, foreignOrg] = (await sql`insert into noelle.organizations(slug,name)
      values ('holds_a','A'),('holds_b','B') returning id`).map((r) => r.id);
    [instance, sibling, foreignInstance] = (await sql`insert into noelle.agent_instances(org_id,role)
      values (${org},'x_intern'),(${org},'linkedin_intern'),(${foreignOrg},'x_intern') returning id`).map((r) => r.id);
  });
  afterAll(async () => { await new Promise((r) => setTimeout(r, 100)); await sql?.end({ timeout: 0 }); });
  async function hold(overrides: { orgId?: string; instanceId?: string; engine?: string; admittedAt?: string } = {}) {
    const [row] = await sql`insert into noelle.llm_budget_reservations
      (id,org_id,agent_instance_id,agent_role,worker,engine,model,bucket,estimated_cents,admitted_at)
      values (gen_random_uuid(),${overrides.orgId ?? org},${overrides.instanceId ?? instance},'x_intern','drafter',
        ${overrides.engine ?? 'bedrock'},'model','drafter',8,coalesce(${overrides.admittedAt ?? null}::text::timestamptz,clock_timestamp())) returning id`;
    return row!.id as string;
  }
  async function receipt(id: string, overrides: Record<string, unknown> = {}) {
    const row = { orgId: org, instanceId: instance, agentRole: "x_intern", worker: "drafter", engine: "bedrock",
      model: "model", bucket: "drafter", cents: 2, basis: "failure_estimate", status: "timeout", ...overrides };
    await sql`insert into noelle.llm_calls
      (org_id,agent_instance_id,agent_role,worker,engine,model,bucket,cents,status,cost_basis,attempt_id)
      values (${row.orgId as string},${row.instanceId as string},${row.agentRole as string},${row.worker as string},
        ${row.engine as string},${row.model as string},${row.bucket as string},${row.cents as number},
        ${row.status as string},${row.basis as string},${id})`;
  }
  it("scopes organization and optional coherent instance without mutating holds", async () => {
    const own = await hold(); await hold({ instanceId: sibling });
    await hold({ orgId: foreignOrg, instanceId: foreignInstance });
    expect((await readPgBudgetHolds(sql, { orgId: org })).holds).toHaveLength(2);
    expect((await readPgBudgetHolds(sql, { orgId: org, instanceId: instance })).holds.map((r) => r.id)).toEqual([own]);
    await expect(readPgBudgetHolds(sql, { orgId: org, instanceId: foreignInstance })).rejects.toMatchObject({ category: "database" });
    expect((await sql`select count(*)::int as n from noelle.llm_budget_reservations where settled_at is null`)[0]?.n).toBe(3);
  });
  it("separates period receipt accounting, retained estimate and the Codex pot", async () => {
    const id = await hold(); await receipt(id);
    await hold({ engine: "codex-cli" }); await hold({ engine: "xapi" });
    const page = await readPgBudgetHolds(sql, { orgId: org });
    expect(page.holds.find((r) => r.id === id)).toMatchObject({ estimatedCents: 8, recordedPeriodCents: 2,
      heldCapacityCents: 6, pot: "common", receipt: { cents: 2, status: "timeout", costBasis: "failure_estimate" } });
    expect(page.holds.find((r) => r.engine === "codex-cli")?.pot).toBe("codex");
    expect(page.holds.find((r) => r.engine === "xapi")?.pot).toBe("infrastructure");
  });
  it.each([
    { field: "orgId", value: () => foreignOrg }, { field: "instanceId", value: () => sibling },
    { field: "agentRole", value: () => "cmo" }, { field: "worker", value: () => "classifier" },
    { field: "engine", value: () => "vertex" }, { field: "model", value: () => "other-model" },
    { field: "bucket", value: () => "classifier" },
  ])("does not attach a valid-FK receipt with contradictory $field", async ({ field, value }) => {
    const id = await hold(); await receipt(id, { [field]: value() });
    const [row] = (await readPgBudgetHolds(sql, { orgId: org })).holds;
    expect(row).toMatchObject({ id, receipt: null, recordedPeriodCents: 0, heldCapacityCents: 8 });
  });
  it("retains old admissions while excluding old-period receipt accounting", async () => {
    const id = await hold({ admittedAt: "2020-01-01 00:00:00+00" }); await receipt(id);
    await sql`update noelle.llm_calls set started_at='2020-01-01' where attempt_id=${id}`;
    const page = await readPgBudgetHolds(sql, { orgId: org, period: "week" });
    expect(page.period).toBe("week");
    expect(page.holds[0]).toMatchObject({ receipt: { cents: 2 }, recordedPeriodCents: 0, heldCapacityCents: 8 });
  });
  it("keeps microsecond cursor precision and visits equal-time ids exactly once", async () => {
    const newest = await hold({ admittedAt: "2026-10-05 12:00:00.123456+00" });
    await hold({ admittedAt: "2026-10-05 12:00:00.123455+00" });
    await hold({ admittedAt: "2026-10-05 12:00:00.123455+00" });
    let page = await readPgBudgetHolds(sql, { orgId: org, limit: 1 });
    expect(page.holds[0]?.id).toBe(newest);
    expect(page.nextCursor?.admittedAt).toContain(".123456");
    const ids = page.holds.map((r) => r.id);
    while (page.nextCursor) {
      page = await readPgBudgetHolds(sql, { orgId: org, limit: 1, cursor: page.nextCursor });
      ids.push(...page.holds.map((r) => r.id));
    }
    expect(ids).toHaveLength(3); expect(new Set(ids).size).toBe(3);
  });
  it("caps rows at 100 and paginates beyond the cap", async () => {
    await sql`insert into noelle.llm_budget_reservations
      (id,org_id,agent_instance_id,agent_role,worker,engine,model,bucket,estimated_cents)
      select gen_random_uuid(),${org},${instance},'x_intern','drafter','bedrock','model','drafter',8 from generate_series(1,150)`;
    const first = await readPgBudgetHolds(sql, { orgId: org, limit: 1000 });
    expect(first.holds).toHaveLength(100); expect(first.nextCursor).not.toBeNull();
    const second = await readPgBudgetHolds(sql, { orgId: org, limit: 100, cursor: first.nextCursor! });
    expect(second.holds).toHaveLength(50); expect(second.nextCursor).toBeNull();
    expect(new Set([...first.holds, ...second.holds].map((r) => r.id)).size).toBe(150);
    expect((await readPgBudgetHolds(sql, { orgId: org, limit: Infinity })).holds).toHaveLength(50);
  });
  it("excludes settled admissions but preserves instance-deleted organization holds", async () => {
    const pending = await hold(); const settled = await hold();
    await sql`update noelle.llm_budget_reservations set settled_at=clock_timestamp() where id=${settled}`;
    await sql`delete from noelle.agent_instances where id=${instance}`;
    expect((await readPgBudgetHolds(sql, { orgId: org })).holds)
      .toEqual([expect.objectContaining({ id: pending, instanceId: null, heldCapacityCents: 8 })]);
  });
  it("reports missing provenance as unknown on a pre0117 schema", async () => {
    const id = await hold(); await receipt(id);
    await sql`alter table noelle.llm_calls drop column cost_basis`;
    try {
      expect((await readPgBudgetHolds(sql, { orgId: org })).holds[0]?.receipt?.costBasis).toBe("unknown");
    } finally {
      await sql.unsafe(await readFile(new URL("../../../infra/cloudsql/schema/0117_llm_cost_basis.sql", import.meta.url), "utf8"));
    }
  });
});
