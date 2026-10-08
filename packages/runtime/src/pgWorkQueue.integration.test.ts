/**
 * PgWorkQueue integration suite — runs the REAL 0087_work_queue.sql migration
 * against a scratch Postgres and exercises every queue semantic through the
 * actual SQL (claim locking, TTL orphan reclaim, dead-letter, dedupe,
 * per-key fairness).
 *
 * Gated: skips entirely unless NOELLE_TEST_DATABASE_URL is set. As a
 * belt-and-braces guard against ever pointing this at the live data plane,
 * the connected database's name must contain "test" or setup aborts —
 * the suite TRUNCATEs noelle.work_queue between tests.
 *
 *   createdb noelle_wq_test
 *   NOELLE_TEST_DATABASE_URL=postgres://localhost:5432/noelle_wq_test \
 *     pnpm --filter @noelle/runtime test pgWorkQueue
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import postgres from "postgres";
import { PgWorkQueue } from "./queue.js";
import type { QueryExecutor } from "./tenancy.js";

const url = process.env.NOELLE_TEST_DATABASE_URL;

describe.skipIf(!url)("PgWorkQueue (integration)", () => {
  let sql: ReturnType<typeof postgres>;
  let exec: QueryExecutor;

  beforeAll(async () => {
    sql = postgres(url!, { max: 4, onnotice: () => {} });
    const dbRows = await sql`select current_database() as db`;
    const db = dbRows[0]?.db;
    if (!String(db).includes("test")) {
      throw new Error(
        `NOELLE_TEST_DATABASE_URL points at "${db}" — refusing to run a TRUNCATE-ing suite outside a *test* database`,
      );
    }
    await sql`create schema if not exists noelle`;
    // The migration grants to noelle_app; make sure the role exists on
    // scratch clusters (nologin, idempotent, harmless).
    await sql.unsafe(
      `do $$ begin if not exists (select from pg_roles where rolname = 'noelle_app')
       then create role noelle_app nologin; end if; end $$;`,
    );
    const migration = resolve(
      dirname(fileURLToPath(import.meta.url)),
      "../../../infra/cloudsql/schema/0087_work_queue.sql",
    );
    await sql.unsafe(readFileSync(migration, "utf8"));
    exec = async (q, params) => sql.unsafe(q, params as never[]);
  });

  beforeEach(async () => {
    await sql`truncate noelle.work_queue`;
  });

  afterAll(async () => {
    await sql?.end();
  });

  const makeQueue = <T,>(opts?: { queue?: string; claimTtlSeconds?: number; maxAttempts?: number }) =>
    new PgWorkQueue<T>(exec, {
      queue: opts?.queue ?? "t.main",
      claimTtlSeconds: opts?.claimTtlSeconds ?? 300,
      maxAttempts: opts?.maxAttempts ?? 5,
    });

  it("round-trips the payload intact (jsonb, not a double-encoded string)", async () => {
    const q = makeQueue<{ lead: string; nested: { deep: number[] } }>();
    await q.enqueue({ lead: "l1", nested: { deep: [1, 2, 3] } });
    const [c] = await q.claim({ batchSize: 1 });
    expect(c?.job).toEqual({ lead: "l1", nested: { deep: [1, 2, 3] } });
    expect(c?.attempt).toBe(0);
  });

  it("ack deletes; the job is gone for good", async () => {
    const q = makeQueue<string>();
    await q.enqueue("done-me");
    const [c] = await q.claim({ batchSize: 1 });
    await q.ack(c!.claimId);
    expect(await q.claim({ batchSize: 5 })).toEqual([]);
    expect(await q.depth()).toBe(0);
    const countRows = await sql`select count(*)::int as n from noelle.work_queue`;
    expect(countRows[0]?.n).toBe(0);
  });

  it("a live claim hides the job; nack releases it with the attempt counted", async () => {
    const q = makeQueue<string>();
    await q.enqueue("retry-me");
    const [c] = await q.claim({ batchSize: 1 });
    expect(await q.claim({ batchSize: 5 })).toEqual([]);
    expect(await q.depth()).toBe(0);

    await q.nack(c!.claimId);
    const [again] = await q.claim({ batchSize: 1 });
    expect(again?.job).toBe("retry-me");
    expect(again?.attempt).toBe(1);
  });

  it("nack with requeueDelaySeconds hides the job until the delay passes", async () => {
    const q = makeQueue<string>();
    await q.enqueue("later");
    const [c] = await q.claim({ batchSize: 1 });
    await q.nack(c!.claimId, { requeueDelaySeconds: 3600 });
    expect(await q.claim({ batchSize: 5 })).toEqual([]);
    expect(await q.depth()).toBe(0);
  });

  it("an expired claim TTL redelivers the job — a dead worker orphans nothing", async () => {
    const q = makeQueue<string>({ claimTtlSeconds: 0 });
    await q.enqueue("orphan");
    const [first] = await q.claim({ batchSize: 1 });
    expect(first?.attempt).toBe(0);
    // No ack, no nack — the "worker" died. TTL 0 = the claim is already expired.
    const [second] = await q.claim({ batchSize: 1 });
    expect(second?.job).toBe("orphan");
    expect(second?.attempt).toBe(1);
    expect(second?.claimId).not.toBe(first?.claimId);
  });

  it("dead-letters after maxAttempts: no more deliveries, visible in deadDepth", async () => {
    const q = makeQueue<string>({ maxAttempts: 2 });
    await q.enqueue("poison");
    for (let i = 0; i < 2; i++) {
      const [c] = await q.claim({ batchSize: 1 });
      expect(c?.attempt).toBe(i);
      await q.nack(c!.claimId);
    }
    expect(await q.claim({ batchSize: 5 })).toEqual([]);
    expect(await q.depth()).toBe(0);
    expect(await q.deadDepth()).toBe(1);
    const deadRows = await sql`select dead_at from noelle.work_queue`;
    expect(deadRows[0]?.dead_at).not.toBeNull();
  });

  it("dead-letters via orphan exhaustion too: repeated TTL expiries with no nack", async () => {
    // The second dead-letter route: a row claimed and orphaned (never
    // nacked) until attempts hit maxAttempts. dead_at is still NULL at that
    // point — deadDepth must see it via attempts, and the next claim's lazy
    // promotion must stamp dead_at so dashboards keyed on it see it too.
    const q = makeQueue<string>({ claimTtlSeconds: 0, maxAttempts: 2 });
    await q.enqueue("crash-loop");
    for (let i = 0; i < 2; i++) {
      const [c] = await q.claim({ batchSize: 1 });
      expect(c?.attempt).toBe(i);
      // No ack, no nack — the worker died mid-job every time.
    }
    // Exhausted, claim expired, not yet promoted: counted via the attempts
    // disjunct even though dead_at is still null.
    const before = await sql`select dead_at, attempts from noelle.work_queue`;
    expect(before[0]?.dead_at).toBeNull();
    expect(before[0]?.attempts).toBe(2);
    expect(await q.deadDepth()).toBe(1);

    // The next claim delivers nothing and lazily promotes the orphan.
    expect(await q.claim({ batchSize: 5 })).toEqual([]);
    expect(await q.depth()).toBe(0);
    expect(await q.deadDepth()).toBe(1);
    const after = await sql`select dead_at from noelle.work_queue`;
    expect(after[0]?.dead_at).not.toBeNull();
  });

  it("an in-flight FINAL attempt is not counted dead while its claim is live", async () => {
    const q = makeQueue<string>({ maxAttempts: 1 });
    await q.enqueue("last-chance");
    const [c] = await q.claim({ batchSize: 1 });
    expect(c?.attempt).toBe(0);
    // attempts == maxAttempts under a live 300s claim: might still ack.
    expect(await q.deadDepth()).toBe(0);
    await q.ack(c!.claimId);
    expect(await q.deadDepth()).toBe(0);
  });

  it("claim honors batchSize as an upper bound", async () => {
    const q = makeQueue<number>();
    for (let i = 0; i < 5; i++) await q.enqueue(i);
    const claimed = await q.claim({ batchSize: 2 });
    expect(claimed.map((c) => c.job)).toEqual([0, 1]);
    expect(await q.depth()).toBe(3);
  });

  it("ack and nack on an unknown claimId are silent no-ops", async () => {
    const q = makeQueue<string>();
    await q.enqueue("still-here");
    await expect(q.ack("00000000-0000-0000-0000-000000000000")).resolves.toBeUndefined();
    await expect(q.nack("00000000-0000-0000-0000-000000000000")).resolves.toBeUndefined();
    expect(await q.depth()).toBe(1);
  });

  it("dedupes on the idempotency key", async () => {
    const q = makeQueue<{ v: number }>();
    await q.enqueue({ v: 1 }, { key: "lead:42" });
    await q.enqueue({ v: 2 }, { key: "lead:42" });
    await q.enqueue({ v: 3 }, { key: "lead:43" });
    expect(await q.depth()).toBe(2);
  });

  it("enqueue delaySeconds hides the job until due", async () => {
    const q = makeQueue<string>();
