import { afterAll, beforeAll, expect, test } from "vitest";
import postgres, { type Sql } from "postgres";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { BoundedPgSession, PgOperationError } from "../dist/boundedPgSession.js";

const url = process.env.NOELLE_PG_LEASE_TEST_DATABASE_URL;
let parent: Sql;
let dir: string;
const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
function barrier() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}
beforeAll(async () => {
  if (!url) return;
  parent = postgres(url, { max: 1, onnotice: () => {}, connection: { idle_in_transaction_session_timeout: 50 } });
  expect((await parent`select current_database() as db`)[0]?.db).toBe("noelle_pg_lease_test");
  dir = await mkdtemp(join(tmpdir(), "noelle-pg-lease-"));
});
afterAll(async () => {
  if (!url) return;
  await parent.end({ timeout: 0 });
  await rm(dir, { recursive: true, force: true });
});

test.skipIf(!url)("eight writers across independent owners serialize until each file operation finishes", async () => {
  const owners = Array.from({ length: 2 }, () => new BoundedPgSession(parent, { deadlineMs: 2_000, maxPending: 32, idleTimeoutMs: 10 }));
  const path = join(dir, "eight.md");
  await writeFile(path, "0");
  let active = 0;
  let maximum = 0;
  await Promise.all(Array.from({ length: 8 }, (_, index) => owners[index % owners.length]!.runLease(async (tx) => {
    await tx`select pg_advisory_xact_lock(173840001)`;
    return index;
  }, async (_index, lease) => {
    active += 1;
    maximum = Math.max(maximum, active);
    try {
      const value = Number(await readFile(path, "utf8"));
      await pause(10);
      await lease.assertActive();
      await writeFile(path, String(value + 1));
    } finally { active -= 1; }
  })));
  expect(maximum).toBe(1);
  expect(await readFile(path, "utf8")).toBe("8");
  expect((await parent`select 1 as alive`)[0]?.alive).toBe(1);
});

test.skipIf(!url)("handoff retains the lease past admission and idle clocks while queued work expires before preparation", async () => {
  const owner = new BoundedPgSession(parent, { deadlineMs: 120, maxPending: 2, idleTimeoutMs: 10 });
  const ready = barrier();
  const finish = barrier();
  let prepared = 0;
  let pid = 0;
  const first = owner.runLease(async (tx) => {
    await tx`select pg_advisory_xact_lock(173840002)`;
    pid = (await tx`select pg_backend_pid() as pid`)[0]!.pid;
  }, async (_data, lease) => {
    ready.release();
    await finish.promise;
    await lease.assertActive();
    return "finished";
  }).catch((error) => { ready.release(); return error; });
  try {
    await ready.promise;
    const second = owner.runLease(async () => { prepared += 1; }, async () => "unexpected").catch((error) => error);
    await pause(260);
    expect((await parent`select pg_try_advisory_lock(173840002) as acquired`)[0]?.acquired).toBe(false);
    expect((await parent`select count(*)::int as n from pg_stat_activity where pid = ${pid}`)[0]?.n).toBe(1);
    expect(await second).toMatchObject({ category: "deadline" });
    expect(prepared).toBe(0);
  } finally { finish.release(); }
  expect(await first).toBe("finished");
  await pause(40);
  expect((await parent`select count(*)::int as n from pg_stat_activity where pid = ${pid}`)[0]?.n).toBe(0);
});

test.skipIf(!url)("connection loss aborts before mutation and awaits the exact callback cleanup before advancing", async () => {
  const owner = new BoundedPgSession(parent, { deadlineMs: 2_000, maxPending: 2, idleTimeoutMs: 10 });
  const ready = barrier();
  const aborted = barrier();
  const work = barrier();
  const cleanupReady = barrier();
  const cleanup = barrier();
  const path = join(dir, "lost.md");
  await writeFile(path, "original");
  let pid = 0;
  let settled = false;
  let nextPrepared = false;
  const first = owner.runLease(async (tx) => {
    await tx`select pg_advisory_xact_lock(173840003)`;
    pid = (await tx`select pg_backend_pid() as pid`)[0]!.pid;
  }, async (_data, lease) => {
    lease.signal.addEventListener("abort", aborted.release, { once: true });
    ready.release();
    try {
      await work.promise;
      await lease.assertActive();
      await writeFile(path, "must not be written");
    } finally {
      cleanupReady.release();
      await cleanup.promise;
    }
  }).catch((error) => {
    ready.release(); aborted.release(); cleanupReady.release(); return error;
  }).finally(() => { settled = true; });
  let next: Promise<unknown> | undefined;
  try {
    await ready.promise;
    next = owner.runLease(async () => { nextPrepared = true; }, async () => "recovered");
    expect((await parent`select pg_terminate_backend(${pid}) as terminated`)[0]?.terminated).toBe(true);
    await aborted.promise;
    expect(settled).toBe(false);
    expect(nextPrepared).toBe(false);
    work.release();
    await cleanupReady.promise;
    expect(settled).toBe(false);
    expect(nextPrepared).toBe(false);
    expect(await readFile(path, "utf8")).toBe("original");
  } finally { work.release(); cleanup.release(); }
  expect(await first).toMatchObject({ category: "connection" });
  expect(await next).toBe("recovered");
  expect((await parent`select 1 as alive`)[0]?.alive).toBe(1);
});

test.skipIf(!url)("ordinary SQL operations retain their bounded deadline", async () => {
  const owner = new BoundedPgSession(parent, { deadlineMs: 120, maxPending: 2, idleTimeoutMs: 10 });
  const started = performance.now();
  await expect(owner.run(async (sql) => { await sql`select pg_sleep(2)`; })).rejects.toBeInstanceOf(PgOperationError);
  expect(performance.now() - started).toBeLessThan(1_000);
  expect((await parent`select 1 as alive`)[0]?.alive).toBe(1);
});
