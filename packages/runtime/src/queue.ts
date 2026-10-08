/**
 * WorkQueue — the durable job-queue primitive for worker pipelines.
 * See docs/scalability.md § 2 and § Pluggable WorkQueue.
 *
 * Production impl: `PgWorkQueue` over the `noelle.work_queue` table
 * (0087_work_queue.sql) — `FOR UPDATE SKIP LOCKED` claims with a TTL
 * (a worker that dies mid-job orphans nothing: the claim expires and the
 * row redelivers), attempt-counted retries, and dead-lettering once a
 * queue's max attempts is exhausted. It takes the same driver-agnostic
 * `QueryExecutor` as tenancy.ts, so this package stays free of any
 * Postgres client dependency.
 *
 * Swap target later: Cloudflare Queues / BullMQ by implementing the same
 * interface and flipping NOELLE_QUEUE_DRIVER. Worker code never imports an
 * implementation directly — it imports `getWorkQueue()` from this module.
 */

import type { QueryExecutor } from "./tenancy.js";

export interface Claimed<T> {
  /** Stable id used for ack/nack. Lives only for the claim's TTL. */
  claimId: string;
  /** The job payload. Shape is queue-specific. */
  job: T;
  /** Number of prior delivery attempts (0 on first delivery). */
  attempt: number;
}

export interface ClaimOptions {
  batchSize: number;
  /**
   * Per-key concurrency caps within a single batch, keyed by a top-level
   * field of the job payload. Prevents one tenant from monopolizing a batch
   * (fairness — docs/scalability.md § 4).
   *
   * Example: `{ org_id: 2 }` means at most 2 of any 5-row batch come from the
   * same `job->>'org_id'`.
   */
  perKeyMax?: Record<string, number>;
}

export interface EnqueueOptions {
  /** Idempotency / dedupe key. A second enqueue with the same key is a no-op. */
  key?: string;
  /** Delay before the job becomes claimable. */
  delaySeconds?: number;
}

export interface NackOptions {
  /** Delay before this job becomes claimable again. Default 0. */
  requeueDelaySeconds?: number;
}

export interface WorkQueue<T> {
  enqueue(job: T, opts?: EnqueueOptions): Promise<void>;
  claim(opts: ClaimOptions): Promise<Claimed<T>[]>;
  ack(claimId: string): Promise<void>;
  nack(claimId: string, opts?: NackOptions): Promise<void>;
  /** Approximate count of claimable jobs. Used as autoscaling signal. */
  depth(): Promise<number>;
}

// -- MemoryWorkQueue (test/dev impl) ---------------------------------------

interface MemoryJob<T> {
  id: string;
  job: T;
  key: string | null;
  availableAt: number;
  attempts: number;
  claimedUntil: number | null;
  claimId: string | null;
  dead: boolean;
}

/**
 * In-memory WorkQueue mirroring PgWorkQueue's semantics — same defaults
 * (300s claim TTL, 5 max attempts), same dedupe-on-key, same dead-letter
 * behavior — so a worker unit-tested against memory sees what pg gives it
 * in production.
 */
export class MemoryWorkQueue<T> implements WorkQueue<T> {
  private jobs: MemoryJob<T>[] = [];
  private counter = 0;

  constructor(
    private readonly claimTtlMs: number = 300_000,
    private readonly maxAttempts: number = 5,
  ) {}

  async enqueue(job: T, opts?: EnqueueOptions): Promise<void> {
    const key = opts?.key ?? null;
    if (key !== null && this.jobs.some((j) => j.key === key)) return;
    this.counter += 1;
    this.jobs.push({
      id: `m_${this.counter}`,
      job,
      key,
      availableAt: Date.now() + (opts?.delaySeconds ?? 0) * 1000,
      attempts: 0,
      claimedUntil: null,
      claimId: null,
      dead: false,
    });
  }

  private isClaimable(j: MemoryJob<T>, now: number): boolean {
    return (
      !j.dead &&
      j.attempts < this.maxAttempts &&
      j.availableAt <= now &&
      (j.claimedUntil === null || j.claimedUntil <= now)
    );
  }

  async claim(opts: ClaimOptions): Promise<Claimed<T>[]> {
    const now = Date.now();
    const out: Claimed<T>[] = [];
    for (const j of this.jobs) {
      if (out.length >= opts.batchSize) break;
      if (!this.isClaimable(j, now)) continue;
      j.attempts += 1;
      j.claimId = `c_${this.counter++}`;
      j.claimedUntil = now + this.claimTtlMs;
      out.push({ claimId: j.claimId, job: j.job, attempt: j.attempts - 1 });
    }
    return out;
  }

  async ack(claimId: string): Promise<void> {
    this.jobs = this.jobs.filter((j) => j.claimId !== claimId);
  }

  async nack(claimId: string, opts?: NackOptions): Promise<void> {
    const j = this.jobs.find((x) => x.claimId === claimId);
    if (!j) return;
    j.claimId = null;
    j.claimedUntil = null;
    j.availableAt = Date.now() + (opts?.requeueDelaySeconds ?? 0) * 1000;
    if (j.attempts >= this.maxAttempts) j.dead = true;
  }

  async depth(): Promise<number> {
    const now = Date.now();
    return this.jobs.filter((j) => this.isClaimable(j, now)).length;
  }

  /** Parity with PgWorkQueue.deadDepth — exhausted jobs, in-flight claims excluded. */
  async deadDepth(): Promise<number> {
    const now = Date.now();
    return this.jobs.filter(
      (j) =>
        j.dead ||
        (j.attempts >= this.maxAttempts && (j.claimedUntil === null || j.claimedUntil <= now)),
    ).length;
  }
}

// -- PgWorkQueue (production impl) -----------------------------------------

export interface PgWorkQueueOptions {
  /** Logical queue name — one `noelle.work_queue` table serves them all. */
  queue: string;
  /**
   * How long a claim protects a row from redelivery. A worker that dies
   * mid-job simply lets the claim expire; the row is claimable again after
   * this many seconds (orphan reclaim). Size it above the worst honest
   * tick duration. Default 300s.
   */
  claimTtlSeconds?: number;
  /**
   * Deliveries before a row is dead-lettered. Once `attempts` reaches this,
   * claim() stops returning the row and nack() stamps `dead_at`. Default 5.
   */
  maxAttempts?: number;
}

/**
 * Postgres-backed WorkQueue over `noelle.work_queue` (0087_work_queue.sql).
 *
 * All semantics live in single-statement SQL — no transactions needed at the
 * call site, safe under concurrent workers:
 *   - claim: `FOR UPDATE SKIP LOCKED` candidate select + `UPDATE RETURNING`
 *     in one CTE; stamps a fresh claim token + TTL, increments attempts.
 *   - ack:  deletes the row (run history belongs to worker_runs).
 *   - nack: releases the claim with an optional redelivery delay;
 *     dead-letters when attempts are exhausted.
 */
export class PgWorkQueue<T> implements WorkQueue<T> {
  private readonly queue: string;
  private readonly claimTtlSeconds: number;
  private readonly maxAttempts: number;

  constructor(
    private readonly executor: QueryExecutor,
    opts: PgWorkQueueOptions,
  ) {
    this.queue = opts.queue;
    this.claimTtlSeconds = opts.claimTtlSeconds ?? 300;
    this.maxAttempts = opts.maxAttempts ?? 5;
  }

  /**
   * The claimable predicate: not dead, attempts left, available, and not
   * under a live claim. An expired `claimed_until` fails no condition —
   * that IS the orphan-reclaim path.
   */
  private static readonly CLAIMABLE =
    `queue = $1 and dead_at is null and attempts < $2 ` +
    `and available_at <= now() and (claimed_until is null or claimed_until <= now())`;

  async enqueue(job: T, opts?: EnqueueOptions): Promise<void> {
    // The payload travels as TEXT and the server parses it: the double cast
    // `($2::text)::jsonb` defeats driver param-type inference. With a bare
    // `$2::jsonb`, postgres.js pre-types the param as jsonb and JSON-encodes
    // the JS value itself — our pre-stringified payload would land as a jsonb
    // STRING (the double-encode trap), and jobs would come back as text.
    await this.executor(
      `insert into noelle.work_queue (queue, job, key, available_at)
       values ($1, ($2::text)::jsonb, $3, now() + make_interval(secs => ($4)::float8))
       on conflict (queue, key) where key is not null do nothing`,
      [this.queue, JSON.stringify(job), opts?.key ?? null, opts?.delaySeconds ?? 0],
    );
  }

  async claim(opts: ClaimOptions): Promise<Claimed<T>[]> {
    // Lazily promote exhausted orphans to dead. nack stamps dead_at itself,
    // but a worker that dies on the FINAL attempt never nacks — the claim
    // expires with attempts == maxAttempts and dead_at still null. Without
    // this, such rows are invisible to any dashboard keyed on dead_at.
    // Live claims are excluded: an in-flight final attempt may still ack.
    await this.executor(
      `update noelle.work_queue
       set dead_at = now(), claim_id = null, claimed_until = null
       where queue = $1 and dead_at is null and attempts >= $2
         and (claimed_until is null or claimed_until <= now())`,
      [this.queue, this.maxAttempts],
    );

    const params: unknown[] = [this.queue, this.maxAttempts, opts.batchSize, this.claimTtlSeconds];

    const perKey = Object.entries(opts.perKeyMax ?? {});
    let candidateSql: string;
    if (perKey.length === 0) {
      candidateSql = `
        select id from noelle.work_queue
        where ${PgWorkQueue.CLAIMABLE}
        order by available_at, seq
        limit $3
        for update skip locked`;
    } else {
      // Rank claimable rows per payload key, cap each key's share of the
      // batch, then lock the survivors. The rank snapshot can go stale
      // between the CTE and the lock (another worker claims a row first) —
      // that's why CLAIMABLE is REPEATED in the locking query below, not
      // just in the CTE: SKIP LOCKED only skips rows whose lock is still
      // held, so a row claimed-and-committed by a concurrent worker after
      // our snapshot would otherwise pass the lock and be double-claimed.
      // With the predicate on the locking level, the locked-row recheck
      // (EvalPlanQual) re-evaluates claimability against the committed
      // version and excludes it — same protection the non-perKey branch
      // gets for free. Worst case is an under-filled batch, never a
      // double-claim.
      const rankCols = perKey.map(([field], i) => {
        params.push(field);
        return `row_number() over (partition by job->>$${params.length} order by available_at, seq) as rn_${i}`;
      });
      const rankConds = perKey.map(([, max], i) => {
        params.push(max);
        return `r.rn_${i} <= $${params.length}`;
      });
      candidateSql = `
        with ranked as (
          select id, ${rankCols.join(", ")}
          from noelle.work_queue
          where ${PgWorkQueue.CLAIMABLE}
        )
        select q.id from noelle.work_queue q
        join ranked r on r.id = q.id
        where ${rankConds.join(" and ")} and ${PgWorkQueue.CLAIMABLE}
        order by q.available_at, q.seq
        limit $3
        for update skip locked`;
    }

    const rows = await this.executor(
      `with candidate as (${candidateSql})
       update noelle.work_queue q
       set claim_id = gen_random_uuid(),
           claimed_until = now() + make_interval(secs => ($4)::float8),
           attempts = q.attempts + 1
       from candidate c
       where q.id = c.id
       returning q.claim_id as claim_id, q.job::text as job, q.attempts as attempts`,
      params,
    );

    // job is selected as ::text and parsed here, deterministically: whether a
    // driver auto-parses jsonb varies (postgres.js sql.unsafe skips jsonb
    // parsing when params are present), and for scalar-string payloads the
    // two behaviors are indistinguishable after the fact.
    return rows.map((r) => ({
      claimId: String(r.claim_id),
      job: JSON.parse(String(r.job)) as T,
      attempt: Number(r.attempts) - 1,
    }));
  }

  async ack(claimId: string): Promise<void> {
    await this.executor(`delete from noelle.work_queue where claim_id = $1`, [claimId]);
  }

  async nack(claimId: string, opts?: NackOptions): Promise<void> {
    await this.executor(
      `update noelle.work_queue
       set claim_id = null,
           claimed_until = null,
           available_at = now() + make_interval(secs => ($2)::float8),
           dead_at = case when attempts >= $3 then now() else dead_at end
       where claim_id = $1`,
      [claimId, opts?.requeueDelaySeconds ?? 0, this.maxAttempts],
    );
  }

  async depth(): Promise<number> {
    const rows = await this.executor(
      `select count(*)::int as depth from noelle.work_queue where ${PgWorkQueue.CLAIMABLE}`,
      [this.queue, this.maxAttempts],
    );
    return Number(rows[0]?.depth ?? 0);
  }

  /**
   * Count of dead-lettered rows (attempts exhausted). Not part of the
   * WorkQueue interface — an observability extra for dashboards/alerts.
   * An in-flight FINAL attempt (attempts == maxAttempts under a live
   * claim) is not counted — it may still ack successfully.
   */
  async deadDepth(): Promise<number> {
    const rows = await this.executor(
      `select count(*)::int as dead from noelle.work_queue
       where queue = $1
         and (dead_at is not null
              or (attempts >= $2 and (claimed_until is null or claimed_until <= now())))`,
      [this.queue, this.maxAttempts],
    );
    return Number(rows[0]?.dead ?? 0);
  }
}

// -- factory ---------------------------------------------------------------

export type WorkQueueDriver = "memory" | "pg";

export interface GetWorkQueueOptions {
  driver?: WorkQueueDriver;
  /** Required when driver=pg. */
  executor?: QueryExecutor;
  /** Required when driver=pg. */
  queue?: string;
  claimTtlSeconds?: number;
  maxAttempts?: number;
}

export function getWorkQueue<T>(opts: GetWorkQueueOptions = {}): WorkQueue<T> {
  const driver = opts.driver ?? (process.env.NOELLE_QUEUE_DRIVER as WorkQueueDriver | undefined) ?? "memory";
  switch (driver) {
    case "memory":
      // Honor the same tuning options as pg (TTL in seconds → ms).
      return new MemoryWorkQueue<T>(
        opts.claimTtlSeconds !== undefined ? opts.claimTtlSeconds * 1000 : undefined,
        opts.maxAttempts,
      );
    case "pg": {
      if (!opts.executor || !opts.queue) {
        throw new Error("getWorkQueue(pg): executor and queue are required");
      }
      const pgOpts: PgWorkQueueOptions = { queue: opts.queue };
      if (opts.claimTtlSeconds !== undefined) pgOpts.claimTtlSeconds = opts.claimTtlSeconds;
      if (opts.maxAttempts !== undefined) pgOpts.maxAttempts = opts.maxAttempts;
      return new PgWorkQueue<T>(opts.executor, pgOpts);
    }
    default: {
      const exhaustive: never = driver;
      throw new Error(`Unknown NOELLE_QUEUE_DRIVER: ${String(exhaustive)}`);
    }
  }
}
