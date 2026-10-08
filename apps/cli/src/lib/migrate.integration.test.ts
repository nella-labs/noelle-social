import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import postgres, { type Sql } from "postgres";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { applyMigrations } from "./migrate.js";
import { findRepoRoot } from "../config.js";

const url = process.env.NOELLE_CLI_MIGRATIONS_TEST_DATABASE_URL;
describe.skipIf(!url)("atomic local migration ledger (dedicated PostgreSQL)", () => {
  let sql: Sql; let schemaDir: string;
  const apply = () => applyMigrations({ adminUrl: url!, schemaDir, log: () => {} });
  beforeAll(async () => {
    sql = postgres(url!, { max: 3, onnotice: () => {} });
    const [database] = await sql<{ db: string }[]>`select current_database() as db`;
    if (database?.db !== "noelle_cli_migrations_test") throw new Error("Dedicated CLI migration test database required");
  });
  beforeEach(async () => {
    schemaDir = mkdtempSync(resolve(tmpdir(), "noelle-cli-migration-test-"));
    await sql`drop schema if exists noelle cascade`;
    await sql`create schema noelle`;
    await sql`create table noelle.schema_migrations(filename text primary key, applied_at timestamptz default now())`;
  });
  afterEach(() => rmSync(schemaDir, { recursive: true, force: true }));
  afterAll(async () => { await sql?.end({ timeout: 1 }); });
  async function rejectLedger() {
    await sql.unsafe("create function noelle.reject_ledger() returns trigger language plpgsql as $$ begin raise exception 'fixture ledger failure'; end $$");
    await sql.unsafe("create trigger reject_ledger before insert on noelle.schema_migrations for each row execute function noelle.reject_ledger()");
  }
  const migration = (name: string, body: string) => writeFileSync(resolve(schemaDir, name), body);
  async function tables() { return sql`select to_regclass('noelle.fixture_table') as name`; }

  it.each([false, true])("rolls back DDL when its ledger receipt fails (legacy wrapper=%s)", async (wrapped) => {
    const name = wrapped ? "0011_rename_drafter_codex_bucket.sql" : "0001_fixture.sql";
    migration(name, `${wrapped ? "begin;\n" : ""}create table noelle.fixture_table(id integer);${wrapped ? "\ncommit;" : ""}`);
    await rejectLedger();
    await expect(apply()).rejects.toThrow("fixture ledger failure");
    expect(await tables()).toEqual([{ name: null }]);
    await sql`drop trigger reject_ledger on noelle.schema_migrations`;
    expect(await apply()).toEqual([name]);
    expect(await apply()).toEqual([]);
  });

  it("serializes independent appliers before they read the ledger", async () => {
    migration("0001_fixture.sql", "select pg_sleep(0.15); create table noelle.fixture_table(id integer);");
    const results = await Promise.allSettled([apply(), apply()]);
    expect(results.every((result) => result.status === "fulfilled")).toBe(true);
    expect(results.flatMap((result) => result.status === "fulfilled" ? result.value : [])).toEqual(["0001_fixture.sql"]);
    expect(await sql`select filename from noelle.schema_migrations`).toEqual([{ filename: "0001_fixture.sql" }]);
  });

  it("rebuilds an invalid concurrent index before recording the migration", async () => {
    await sql`create table noelle.leads(org_id text, platform text, external_id text)`;
    await sql`insert into noelle.leads values ('org','x','duplicate'),('org','x','duplicate')`;
    const name = "0106_tenant_scoped_lead_identity.sql";
    migration(name, readFileSync(resolve(findRepoRoot(), "infra/cloudsql/schema", name), "utf8"));
    await expect(apply()).rejects.toThrow();
    const validity = () => sql`select indisvalid from pg_index where indexrelid=to_regclass('noelle.leads_org_platform_external_id_uq')`;
    expect(await validity()).toEqual([{ indisvalid: false }]);
    await sql`delete from noelle.leads`;
    expect(await apply()).toEqual([name]);
    expect(await validity()).toEqual([{ indisvalid: true }]);
  });

  it("refuses a same-name index with a contradictory native shape", async () => {
    await sql`create table noelle.leads(org_id text, platform text, external_id text)`;
    await sql`create unique index leads_org_platform_external_id_uq on noelle.leads(external_id)`;
    const name = "0106_tenant_scoped_lead_identity.sql";
    migration(name, readFileSync(resolve(findRepoRoot(), "infra/cloudsql/schema", name), "utf8"));
    await expect(apply()).rejects.toThrow("index shape differs");
    expect(await sql`select filename from noelle.schema_migrations`).toEqual([]);
    expect(await sql`select indisvalid from pg_index where indexrelid=to_regclass('noelle.leads_org_platform_external_id_uq')`)
      .toEqual([{ indisvalid: true }]);
  });

  it("bounds lock admission and cannot run DDL while another applier owns the session lock", async () => {
    migration("0001_fixture.sql", "create table noelle.fixture_table(id integer)");
    const holder = await sql.reserve();
    await holder`select pg_advisory_lock(721468321, 0)`;
    try {
      await expect(apply()).rejects.toMatchObject({ code: "55P03" });
      expect(await tables()).toEqual([{ name: null }]);
    } finally {
      await holder`select pg_advisory_unlock(721468321, 0)`;
      holder.release();
    }
  }, 10_000);

  it("drops an interrupted transaction without rollback on a dead reserved socket", async () => {
    migration("0001_fixture.sql", "create table noelle.fixture_table(id integer); select pg_sleep(10) /* migration_disconnect_probe */;");
    const result = apply().then(() => null, (error: { code?: string }) => error);
    let pid: number | undefined;
    await vi.waitFor(async () => {
      const [row] = await sql<{ pid: number }[]>`select pid from pg_stat_activity
        where datname=current_database() and application_name='noelle-cli-migrations'
          and state='active' and query like ${"%migration_disconnect_probe%"}`;
      pid = row?.pid;
      expect(pid).toBeDefined();
    }, { timeout: 1500, interval: 10 });
    await sql`select pg_terminate_backend(${pid!})`;
    expect((await result)?.code).toMatch(/^(57P01|CONNECTION_CLOSED)$/);
    expect(await tables()).toEqual([{ name: null }]);
    expect(await sql`select filename from noelle.schema_migrations`).toEqual([]);
  });

  it("records an already valid concurrent index after a failed ledger acknowledgment", async () => {
    await sql`create table noelle.leads(org_id text, platform text, external_id text)`;
    const name = "0106_tenant_scoped_lead_identity.sql";
    migration(name, readFileSync(resolve(findRepoRoot(), "infra/cloudsql/schema", name), "utf8"));
    await rejectLedger();
    await expect(apply()).rejects.toThrow("fixture ledger failure");
    await sql`drop trigger reject_ledger on noelle.schema_migrations`;
    expect(await apply()).toEqual([name]);
    expect(await sql`select indisvalid from pg_index where indexrelid=to_regclass('noelle.leads_org_platform_external_id_uq')`)
      .toEqual([{ indisvalid: true }]);
  });
});
