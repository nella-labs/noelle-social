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
