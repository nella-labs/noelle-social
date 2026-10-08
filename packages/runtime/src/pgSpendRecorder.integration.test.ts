import postgres, { type Sql } from "postgres";
import { createServer, type Socket } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createPgSpendRecorder } from "./pgSpendRecorder.js";
import type { SpendRow } from "./spendRecorder.js";

const url = process.env.NOELLE_SPEND_RECORDER_TEST_DATABASE_URL;
const row: SpendRow = {
  orgId: "org_test", instanceId: "instance_test", agentRole: "x_intern",
  worker: "boundary", engine: "apify", model: "actor", bucket: "data",
  inputTokens: 0, outputTokens: 0, cents: 3, latencyMs: 1, status: "ok",
  startedAt: new Date("2026-10-05T12:00:00Z"), credentialId: null,
};
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

describe.skipIf(!url)("spend recorder ownership (PostgreSQL)", () => {
  let control: Sql;
  const parents: Sql[] = [];
  const makeParent = (options: Parameters<typeof postgres>[1] = {}) => {
    const sql = postgres(url!, { max: 5, onnotice: () => {}, ...options });
    parents.push(sql);
    return sql;
  };
  const makeRecorder = (sql: Sql, options: import("./pgSpendRecorder.js").PgSpendRecorderOptions = {}) =>
    createPgSpendRecorder(sql, {
      deadlineMs: 300, idleTimeoutMs: 50, onFailure: vi.fn(), ...options,
    });

  beforeAll(async () => {
    control = postgres(url!, { max: 3, onnotice: () => {} });
    const [current] = await control`select current_database() as db`;
    if (!String(current?.db).includes("spend_recorder_test")) throw Error("dedicated spend recorder test database required");
    await control`drop schema if exists noelle cascade`;
    await control`create schema noelle`;
    await control`create table noelle.llm_calls (
      org_id text, agent_instance_id text, agent_role text, worker text, engine text,
      model text, bucket text, input_tokens int, output_tokens int, cents int,
      latency_ms int, status text, started_at timestamptz, credential_id text
    )`;
  });
  beforeEach(async () => { await control`truncate noelle.llm_calls`; });
  afterAll(async () => {
    await delay(100);
    await Promise.all(parents.map((sql) => sql.end({ timeout: 0 })));
    await control?.end({ timeout: 0 });
  });

  async function holdTable() {
    let release!: () => void;
    let locked!: () => void;
    const ready = new Promise<void>((resolve) => { locked = resolve; });
    const released = new Promise<void>((resolve) => { release = resolve; });
    const transaction = control.begin(async (tx) => {
      await tx`lock table noelle.llm_calls in access exclusive mode`;
      locked(); await released;
    });
    await ready;
    return async () => { release(); await transaction; };
  }

  it("records eight parallel charges and preserves their attribution", async () => {
    const parent = makeParent();
    const recorder = makeRecorder(parent, { deadlineMs: 2000 });
    await Promise.all(Array.from({ length: 8 }, (_, i) => recorder.record({ ...row, worker: `charge_${i}`, cents: i + 1 })));
    const [totals] = await control`select count(*)::int as n, sum(cents)::int as cents, count(distinct worker)::int as workers from noelle.llm_calls`;
    expect(totals).toEqual({ n: 8, cents: 36, workers: 8 });
    const [saved] = await control`select org_id,agent_instance_id,credential_id,status from noelle.llm_calls limit 1`;
    expect(saved).toEqual({ org_id: "org_test", agent_instance_id: "instance_test", credential_id: null, status: "ok" });
  });

  it("records while all five parent connections are reserved", async () => {
    const parent = makeParent();
    const slots = await Promise.all(Array.from({ length: 5 }, () => parent.reserve()));
    const release = setTimeout(() => slots.forEach((slot) => slot.release()), 650);
    try {
      const started = performance.now();
      await makeRecorder(parent).record(row);
      expect(performance.now() - started).toBeLessThan(500);
    } finally { clearTimeout(release); slots.forEach((slot) => slot.release()); }
    expect((await parent`select 1 as healthy`)[0]?.healthy).toBe(1);
  });

  it("rejects a blocked write before return and never inserts it later", async () => {
    const parent = makeParent({ connection: { application_name: "spend_test_blocked" } });
    const recorder = makeRecorder(parent);
    const unlock = await holdTable();
    const safety = setTimeout(() => { void unlock(); }, 650);
    try {
      const started = performance.now();
      await expect(recorder.record(row)).rejects.toMatchObject({ name: "SpendRecordingError", category: "deadline" });
      expect(performance.now() - started).toBeLessThan(550);
      const active = await control`select count(*)::int as n from pg_stat_activity where datname=current_database() and application_name='spend_test_blocked' and state='active'`;
      expect(active[0]?.n).toBe(0);
    } finally { clearTimeout(safety); await unlock(); }
    await delay(100);
    expect((await control`select count(*)::int as n from noelle.llm_calls`)[0]?.n).toBe(0);
    await recorder.record({ ...row, worker: "after_recovery" });
    expect((await control`select worker from noelle.llm_calls`).map((x) => x.worker)).toEqual(["after_recovery"]);
    expect((await parent`select 1 as healthy`)[0]?.healthy).toBe(1);
  });

  it("expires queued receipts before query creation and reports bounded admission", async () => {
    const parent = makeParent();
    const recorder = makeRecorder(parent, { maxPending: 3 });
    const unlock = await holdTable();
    const safety = setTimeout(() => { void unlock(); }, 650);
    let results: PromiseSettledResult<void>[];
    try {
      results = await Promise.allSettled(Array.from({ length: 8 }, (_, i) => recorder.record({ ...row, worker: `outage_${i}` })));
    } finally { clearTimeout(safety); await unlock(); }
    expect(results!.filter((x) => x.status === "fulfilled")).toHaveLength(0);
    expect(results!.filter((x) => x.status === "rejected" && x.reason.category === "queue_full")).toHaveLength(5);
    expect(results!.filter((x) => x.status === "rejected" && x.reason.category === "deadline")).toHaveLength(3);
    await delay(100);
    expect((await control`select count(*)::int as n from noelle.llm_calls`)[0]?.n).toBe(0);
  });

  it("closes an unresponsive owned connection without changing parent timeouts", async () => {
    const sockets = new Set<Socket>();
    const server = createServer((socket) => {
      sockets.add(socket);
      socket.on("data", () => {});
      socket.on("close", () => sockets.delete(socket));
    });
    await new Promise<void>((resolve) => { server.listen(0, "127.0.0.1", resolve); });
    const address = server.address();
    if (!address || typeof address === "string") throw Error("TCP fixture address required");
    const parent = makeParent({ host: "127.0.0.1", port: address.port, connect_timeout: 30 });
    try {
      const started = performance.now();
      await expect(makeRecorder(parent, { deadlineMs: 300 }).record(row)).rejects.toMatchObject({ name: "SpendRecordingError", category: "connection" });
      expect(performance.now() - started).toBeLessThan(550);
      await vi.waitFor(() => { expect(sockets.size).toBe(0); }, { timeout: 250 });
      expect(parent.options.connect_timeout).toBe(30);
    } finally {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) => { server.close((error) => error ? reject(error) : resolve()); });
    }
  });

  it("makes SQL failures observable without retaining SQL or parameter details", async () => {
    const parent = makeParent();
    const failures: unknown[] = [];
    const recorder = makeRecorder(parent, { onFailure: (failure: unknown) => { failures.push(failure); } });
    await control`alter table noelle.llm_calls add constraint reject_spend check (cents < 0) not valid`;
    try {
      const error = await recorder.record({ ...row, model: "private_parameter_value" }).catch((e: unknown) => e);
      expect(error).toMatchObject({ name: "SpendRecordingError", category: "database" });
      expect(failures).toHaveLength(1);
      expect(JSON.stringify(failures)).not.toContain("private_parameter_value");
      expect(error).not.toHaveProperty("query");
      expect(error).not.toHaveProperty("parameters");
      expect(error).not.toHaveProperty("cause");
    } finally { await control`alter table noelle.llm_calls drop constraint reject_spend`; }
  });
});
