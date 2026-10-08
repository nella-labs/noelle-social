import { beforeAll, beforeEach, afterAll, describe, it, expect, vi } from "vitest";
import type { Sql } from "postgres";
import { withTimeout } from "./db-retry";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
type PostgresModule = { default: typeof import("postgres") };

const state = vi.hoisted(() => ({ fault: "" as "" | "insert" | "update" | "select" | "transaction", dropped: false, lossesRemaining: 1, attempts: 0, max: 1, statementTimeoutMs: 8000, clients: [] as Sql[], forcedEnds: 0, kill: async (_pid: number) => {} }));
vi.mock("next/headers", () => ({ headers: vi.fn() }));
vi.mock("@google-cloud/cloud-sql-connector", () => ({ Connector: class {}, IpAddressTypes: {}, AuthTypes: {} }));
vi.mock("google-auth-library", () => ({ ExternalAccountClient: {}, GoogleAuth: class {} }));
vi.mock("react", () => ({ cache: <T>(fn: T) => fn }));
vi.mock("./auth-cookie", () => ({ getUserFromCookies: async () => ({ id: "fixture-member" }) }));
vi.mock("./supabase/server", () => ({ createSupabaseServerClient: async () => ({}) }));
vi.mock("@noelle/runtime", () => ({ assertOrgMember: async () => {} }));
vi.mock("postgres", async () => {
  const actual = await vi.importActual<PostgresModule>("postgres");
  return { default: (...args: Parameters<typeof actual.default>) => {
    const client = actual.default(args[0], { ...args[1], max: state.max, connection: { ...args[1]?.connection, statement_timeout: state.statementTimeoutMs } });
    state.clients.push(client);
    function instrument(client: Sql): Sql {
    return new Proxy(client, {
      get(target, property) {
        if (property === "reserve") return async () => instrument(await target.reserve());
        if (property === "begin") return async (...args: unknown[]) => {
          const result = await Reflect.apply(target.begin, target, args);
          if (state.fault === "transaction" && state.lossesRemaining > 0) {
            state.lossesRemaining -= 1;
            throw Object.assign(new Error("fixture transaction result lost after commit"), { code: "ECONNRESET" });
          }
          return result;
        };
        if (property !== "end") return Reflect.get(target, property);
        return (options?: { timeout?: number }) => {
          if (options?.timeout === 0) state.forcedEnds += 1;
          return target.end(options);
        };
      },
      apply(target, receiver, queryArgs) {
        const template = queryArgs[0];
        if (!Array.isArray(template) || !("raw" in template)) return Reflect.apply(target, receiver, queryArgs);
        const text = template.join("?").toLowerCase();
        if (!text.includes("audit_retry.probe")) return Reflect.apply(target, receiver, queryArgs);
        state.attempts += 1;
        if (!state.fault || state.lossesRemaining === 0) return Reflect.apply(target, receiver, queryArgs);
        const query = Reflect.apply(target, receiver, queryArgs);
        let dispatched: Promise<unknown> | undefined;
        const dispatch = () => dispatched ??= (async () => {
          const fault = state.lossesRemaining > 0 && text.trim().startsWith(state.fault);
          if (fault && state.fault === "select") {
            const [row] = await target<{ pid: number }[]>`select pg_backend_pid() as pid`;
            state.dropped = true;
            state.lossesRemaining -= 1;
            await state.kill(row!.pid);
            throw Object.assign(new Error("fixture connection lost before read"), { code: "ECONNRESET" });
          }
          const rows = await query;
          if (fault) {
            state.dropped = true;
            state.lossesRemaining -= 1;
            throw Object.assign(new Error("fixture result lost after commit"), { code: "ECONNRESET" });
          }
          return rows;
        })();
        return new Proxy(query, { get(query, property, receiver) {
          if (property === "then" || property === "catch" || property === "finally") {
            return (...args: unknown[]) => Reflect.apply(Reflect.get(dispatch(), property), dispatched, args);
          }
          return Reflect.get(query, property, receiver);
        } });
      },
    });
    }
    return instrument(client);
  } };
});

const url = process.env.NOELLE_DASHBOARD_RETRY_TEST_DATABASE_URL;
describe.skipIf(!url)("dashboard actual SQL wrapper with committed result loss", () => {
  let native: Sql;
  let sql: Sql;
  let readSql: typeof import("./db").readSql;
  let withTx: typeof import("./db").withTx;
  beforeAll(async () => {
    const actual = await vi.importActual<PostgresModule>("postgres");
    native = actual.default(url!, { max: 2, onnotice: () => {} });
    const [row] = await native`select current_database() as db`;
    if (!row?.db.endsWith("_dashboard_retry_test")) throw new Error("Dedicated dashboard retry test database required");
    await native`create schema if not exists audit_retry`;
    await native`create table if not exists audit_retry.probe(id bigserial primary key, label text, value int not null default 0)`;
    await native`alter table audit_retry.probe add column if not exists payload jsonb`;
    await native`create schema if not exists noelle`;
    await native`create table if not exists noelle.bus_events(id text, org_id text, agent_instance_id text,
      agent_role text, worker text, topic text, severity text, summary text, payload jsonb,
      correlation_id text, created_at timestamptz default now())`;
    await native`create table if not exists noelle.bus_state(org_id text, bucket text, key text, value jsonb,
      version int default 1, updated_by_worker text, updated_at timestamptz default now(), expires_at timestamptz)`;
    await native.unsafe("create or replace function audit_retry.mutate() returns integer language plpgsql as $$ begin insert into audit_retry.probe(label) values ('function'); return 1; end $$");
    state.kill = async (pid) => { await native`select pg_terminate_backend(${pid})`; };
  });
  beforeEach(async () => {
    await Promise.all(state.clients.map((client) => client.end({ timeout: 0 })));
    state.clients = []; state.fault = ""; state.dropped = false; state.lossesRemaining = 1; state.attempts = 0; state.max = 1; state.statementTimeoutMs = 8000; state.forcedEnds = 0;
    await native`truncate audit_retry.probe restart identity`;
    await native`truncate noelle.bus_events, noelle.bus_state`;
    globalThis.__noelleSql = undefined; globalThis.__noelleConnector = undefined;
    vi.resetModules();
    vi.stubEnv("NOELLE_DATABASE_URL", `${url}?sslmode=disable`);
    for (const key of ["NOELLE_GCP_PROJECT_NUMBER", "NOELLE_GCP_POOL_ID", "NOELLE_GCP_PROVIDER_ID", "NOELLE_GCP_SA_EMAIL", "NOELLE_CLOUDSQL_INSTANCE"]) vi.stubEnv(key, "");
    const owner = await import("./db");
    sql = owner.sql;
    withTx = owner.withTx;
    readSql = owner.readSql;
  });

  it("constructs cold JSON, identifier and array builders synchronously from one lazy pool", async () => {
    const json = sql.json({ supported: true });
    const identifier = sql("payload");
    const values = sql([1, 2]);
    expect(json).not.toBeInstanceOf(Promise);
    expect(identifier).not.toBeInstanceOf(Promise);
    expect(values).not.toBeInstanceOf(Promise);
    expect(state.clients).toHaveLength(1);
    await sql`insert into audit_retry.probe(label,payload) values ('cold', ${json})`;
    expect(await sql`select ${identifier} from audit_retry.probe where id in ${values}`)
      .toEqual([{ payload: { supported: true } }]);
    expect(state.clients).toHaveLength(1);
  });

  it.each([
    ["topic value", { topic: "fixture" }, undefined, 1],
    ["empty topic fragment", {}, undefined, 2],
    ["instance value", { instanceId: "instance-a" }, undefined, 1],
    ["empty instance fragment", {}, undefined, 2],
    ["bucket value", undefined, "fixture", 1],
    ["empty bucket fragment", undefined, undefined, 2],
  ] as const)("cold actual bus consumer handles %s", async (_name, opts, bucket, count) => {
    await native`insert into noelle.bus_events(id,org_id,agent_instance_id,agent_role,topic,severity,payload)
      values ('a','fixture-org','instance-a','x_intern','fixture','info','{}'),
             ('b','fixture-org','instance-b','x_intern','other','info','{}')`;
    await native`insert into noelle.bus_state(org_id,bucket,key,value)
      values ('fixture-org','fixture','a','{}'),('fixture-org','other','b','{}')`;
    const { listBusEvents, getBusState } = await import("./queries");
    const rows = opts === undefined
      ? await getBusState("fixture-org", bucket)
      : await listBusEvents("fixture-org", opts);
    expect(rows).toHaveLength(count);
    expect(state.clients).toHaveLength(1);
  });

  it("rejects a NaN bus limit before opening a data connection", async () => {
    const { listBusEvents } = await import("./queries");
    await expect(listBusEvents("fixture-org", { limit: Number.NaN })).rejects.toMatchObject({ name: "ZodError" });
    expect(state.clients).toHaveLength(0);
  });

  it.each([
    [1.5, 1], [0, 1], [-5, 1], [Infinity, 2], [-Infinity, 1], [600, 2], [undefined, 2],
  ])("bounds actual bus data for numeric limit %s", async (limit, count) => {
    await native`insert into noelle.bus_events(id,org_id,agent_role,topic,severity,payload)
      values ('a','fixture-org','x_intern','fixture','info','{}'),
             ('b','fixture-org','x_intern','other','info','{}')`;
    const { listBusEvents } = await import("./queries");
    const opts = limit === undefined ? {} : { limit };
    expect(await listBusEvents("fixture-org", opts)).toHaveLength(count);
    expect(state.clients).toHaveLength(1);
  });

  it("preserves native simple/execute chaining and shares one dispatched result across observers", async () => {
    const query = sql`insert into audit_retry.probe(label) values ('single dispatch') returning id`.simple();
    expect(query.execute()).toBe(query);
    const [first, second] = await Promise.all([query, query.then((rows) => rows)]);
    expect(first).toEqual(second);
    expect(await native`select label from audit_retry.probe`).toEqual([{ label: "single dispatch" }]);
    expect(state.attempts).toBe(1);
    expect(state.clients).toHaveLength(1);
  });

  it("bounds cold unsafe/file queries through the same prepared pool", async () => {
    expect(await sql.unsafe("select $1::text as value", ["unsafe"])).toEqual([{ value: "unsafe" }]);
    const directory = await mkdtemp(join(tmpdir(), "noelle-db-query-"));
    try {
      const path = join(directory, "read.sql");
      await writeFile(path, "select 'file'::text as value");
      expect(await sql.file(path).simple().execute()).toEqual([{ value: "file" }]);
    } finally { await rm(directory, { recursive: true, force: true }); }
    expect(state.clients).toHaveLength(1);
  });
  afterAll(async () => {
    await Promise.all(state.clients.map((client) => client.end({ timeout: 0 })));
    await native?.end(); vi.unstubAllEnvs();
    globalThis.__noelleSql = undefined; globalThis.__noelleConnector = undefined;
  });

  it("never replays an INSERT after native commit with a lost result", async () => {
    state.fault = "insert";
    const result = await sql`insert into audit_retry.probe(label) values ('fixture') returning id`.then(() => ({ ok: true }), (error: unknown) => ({ ok: false, error }));
    const rows = await native`select id,label from audit_retry.probe order by id`;
    expect(state.dropped, `fixture injector: clients=${state.clients.length}, attempts=${state.attempts}`).toBe(true);
    expect(rows).toHaveLength(1);
    expect(result.ok).toBe(false);
    expect(state.attempts).toBe(1);
  });
  it("never increments twice after a committed UPDATE result is lost", async () => {
    await native`insert into audit_retry.probe(label) values ('fixture')`;
    state.fault = "update";
    const result = await sql`update audit_retry.probe set value=value+1 returning value`.then(() => ({ ok: true }), (error: unknown) => ({ ok: false, error }));
    expect(state.dropped, `fixture injector: clients=${state.clients.length}, attempts=${state.attempts}`).toBe(true);
    expect((await native`select value from audit_retry.probe`)[0]?.value).toBe(1);
    expect(result.ok).toBe(false);
    expect(state.attempts).toBe(1);
  });
  it("never replays a transaction callback after native COMMIT loses its result", async () => {
    state.fault = "transaction";
    const callback = vi.fn(async (tx: import("postgres").TransactionSql) => { await tx`insert into audit_retry.probe(label) values ('transaction')`; });
    await expect(withTx(callback)).rejects.toMatchObject({ code: "ECONNRESET" });
    expect(callback).toHaveBeenCalledOnce();
    expect(await native`select label from audit_retry.probe`).toEqual([{ label: "transaction" }]);
    expect(state.forcedEnds).toBe(0);
  });
  it("refuses a mutating SELECT function inside the actual read-only transaction", async () => {
    const result = await readSql`select audit_retry.mutate()`.then(() => null, (error: { code?: string }) => error.code);
    expect(result).toBe("25006");
    expect(await native`select id from audit_retry.probe`).toHaveLength(0);
    expect(await readSql`select count(*)::int as n from audit_retry.probe`).toEqual([{ n: 0 }]);
  });
  it("refuses a writable CTE inside the actual read-only transaction", async () => {
    const result = await readSql`with changed as (insert into audit_retry.probe(label) values ('cte') returning id) select id from changed`.then(() => null, (error: { code?: string }) => error.code);
    expect(result).toBe("25006");
    expect(await native`select id from audit_retry.probe`).toHaveLength(0);
  });
  it("recovers a dropped read using the same pool without a forceful shutdown", async () => {
    state.fault = "select";
    expect(await readSql`select count(*)::int as n from audit_retry.probe`).toEqual([{ n: 0 }]);
    expect(state.dropped).toBe(true);
    expect(state.clients).toHaveLength(1);
    expect(state.forcedEnds).toBe(0);
  });
  it("exhausted read retries release failed reservations through driver closure and allow the next reader", async () => {
    state.fault = "select"; state.lossesRemaining = 3;
    await expect(readSql`select count(*)::int as n from audit_retry.probe`).rejects.toMatchObject({ code: "ECONNRESET" });
    expect(state.lossesRemaining).toBe(0);
    expect(await readSql`select count(*)::int as n from audit_retry.probe`).toEqual([{ n: 0 }]);
    expect(state.clients).toHaveLength(1);
    expect(state.forcedEnds).toBe(0);
  });
  it("native statement cancellation rolls back read-only state and releases the connection for a writer", async () => {
    state.statementTimeoutMs = 100;
    await expect(readSql`select pg_sleep(1)`).rejects.toMatchObject({ code: "57014" });
    expect(await readSql`select count(*)::int as n from audit_retry.probe`).toEqual([{ n: 0 }]);
    await sql`insert into audit_retry.probe(label) values ('after canceled read')`;
    expect(await native`select label from audit_retry.probe`).toEqual([{ label: "after canceled read" }]);
    expect(state.clients).toHaveLength(1);
    expect(state.forcedEnds).toBe(0);
  });
  it("reconnects after a real backend termination and preserves another in-flight transaction", async () => {
    state.max = 2; // Exercise shared-pool concurrency through actual postgres.js connections.
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    let started!: () => void;
    const writeStarted = new Promise<void>((resolve) => { started = resolve; });
    const writing = sql.begin(async (tx) => {
      await tx`set local idle_in_transaction_session_timeout='20s'`;
      await tx`insert into audit_retry.probe(label) values ('surviving transaction')`;
      started(); await barrier;
    }).then(() => ({ ok: true }), (error: unknown) => ({ ok: false, error }));
    try {
      await withTimeout(writeStarted, 1000, "fixture write start");
      const reading = readSql`select 1 as n, pg_sleep(2) as delay /* native_read_reconnect */`.then(() => ({ ok: true }), (error: unknown) => ({ ok: false, error }));
      let pid: number | undefined;
      const until = Date.now() + 2000;
      while (!pid && Date.now() < until) {
        const [row] = await native<{ pid: number }[]>`select pid from pg_stat_activity
          where datname=current_database() and pid<>pg_backend_pid() and state='active'
            and query like 'select 1 as n, pg_sleep%native_read_reconnect%' limit 1`;
        pid = row?.pid;
        if (!pid) await new Promise((resolve) => setTimeout(resolve, 5));
      }
      expect(pid).toBeTypeOf("number");
      await native`select pg_terminate_backend(${pid!})`;
      const outcome = await withTimeout(reading, 12000, "fixture read recovery");
      expect(outcome.ok).toBe(true);
    } finally { release(); }
    expect((await writing).ok).toBe(true);
    expect(await native`select label from audit_retry.probe`).toEqual([{ label: "surviving transaction" }]);
    expect(state.clients).toHaveLength(1);
    expect(state.forcedEnds).toBe(0);
  }, 15000);
});
