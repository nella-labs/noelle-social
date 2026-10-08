import postgres, { type Sql, type ISql } from "postgres";

export type PgOperationCategory = "deadline" | "queue_full" | "database" | "connection";
export class PgOperationError extends Error {
  constructor(readonly category: PgOperationCategory) {
    super(`Bounded database operation failed: ${category}`);
    this.name = "PgOperationError";
  }
}
export interface BoundedPgConfig {
  deadlineMs: number;
  maxPending: number;
  idleTimeoutMs: number;
}
export interface PgLease {
  readonly signal: AbortSignal;
  /** Confirm the owned transaction is still connected immediately before mutation. */
  assertActive(): Promise<void>;
}
type Item = {
  execute: (sql: Sql, item: Item) => Promise<unknown>;
  expiresAt: number;
  timer: ReturnType<typeof setTimeout>;
  started: boolean;
  expired: boolean;
  holding?: boolean;
  connectionLost?: () => void;
  disposal?: Promise<void>;
  resolve: (value: unknown) => void;
  reject: (error: PgOperationError) => void;
};

function timeoutCeiling(value: unknown, ceiling: number): number {
  const units: Record<string, number> = { ms: 1, s: 1000, min: 60_000, h: 3_600_000, d: 86_400_000 };
  const match = typeof value === "string" ? /^\s*(\d+(?:\.\d+)?)\s*(ms|s|min|h|d)?\s*$/.exec(value) : null;
  const configured = typeof value === "number" ? value : match ? Number(match[1]) * units[match[2] ?? "ms"]! : 0;
  return Number.isFinite(configured) && configured > 0 ? Math.min(ceiling, Math.max(1, Math.floor(configured))) : ceiling;
}

function category(error: unknown): PgOperationCategory {
  const code = error && typeof error === "object" && "code" in error ? error.code : null;
  if (code === "57014" || code === "55P03") return "deadline";
  return typeof code === "string" && /^\d[A-Z\d]{4}$/.test(code) ? "database" : "connection";
}

/** A bounded, nonpipelined owned session; ordinary run callbacks perform SQL only. */
export class BoundedPgSession {
  private readonly queue: Item[] = [];
  private active: Item | undefined;
  private pool: Sql | undefined;
  private idleTimer: ReturnType<typeof setTimeout> | undefined;
  private idleDisposal: Promise<void> | undefined;

  constructor(private readonly parent: Sql, private readonly config: BoundedPgConfig) {}

  run<T>(execute: (sql: Sql) => Promise<T>): Promise<T> {
    return this.admit(execute);
  }

  /** Admission is bounded; an admitted lease remains owned until external work and cleanup finish. */
  runLease<T, R>(
    prepare: (sql: ISql) => Promise<T>,
    work: (prepared: T, lease: PgLease) => Promise<R>,
  ): Promise<R> {
    return this.admit(async (sql, item) => {
      const controller = new AbortController();
      let connected = true;
      item.connectionLost = () => { connected = false; controller.abort(); };
      // Initialize the owned connection before reserving its transaction session.
      await sql`select 1`;
      const tx = await sql.reserve();
      try {
        await tx`begin`;
        await tx`set local idle_in_transaction_session_timeout = 0`;
        const prepared = await prepare(tx);
        if (item.expired || performance.now() >= item.expiresAt) throw new PgOperationError("deadline");
        if (!connected) throw new PgOperationError("connection");
        item.holding = true;
        clearTimeout(item.timer);
        const result = await work(prepared, {
          signal: controller.signal,
          assertActive: async () => {
            if (controller.signal.aborted) throw new PgOperationError("connection");
            try { await tx`select 1`; }
            catch (error) { controller.abort(); throw new PgOperationError(category(error)); }
            if (controller.signal.aborted) throw new PgOperationError("connection");
          },
        });
        if (!connected) throw new PgOperationError("connection");
        await tx`commit`;
        return result;
      }
      catch (error) {
        controller.abort();
        if (connected) await tx`rollback`.catch(() => {});
        throw error;
      } finally {
        controller.abort();
        // The exact work/cleanup Promise has settled before releasing or disposing this session.
        if (connected) tx.release();
      }
    });
  }

  private admit<T>(execute: (sql: Sql, item: Item) => Promise<T>): Promise<T> {
    if (this.queue.length + (this.active ? 1 : 0) >= this.config.maxPending) {
      return Promise.reject(new PgOperationError("queue_full"));
    }
    if (this.idleTimer) clearTimeout(this.idleTimer);
    return new Promise<T>((resolve, reject) => {
      const item: Item = {
        execute, resolve: (value) => resolve(value as T), reject, started: false, expired: false,
        expiresAt: performance.now() + this.config.deadlineMs,
        timer: setTimeout(() => this.expire(item), this.config.deadlineMs),
      };
      this.queue.push(item);
      void this.drain();
    });
  }

  private expire(item: Item): void {
    if (item.holding) return;
    item.expired = true;
    if (!item.started) {
      const index = this.queue.indexOf(item);
      if (index >= 0) this.queue.splice(index, 1);
      item.reject(new PgOperationError("deadline"));
    } else if (this.pool) {
      const pool = this.pool;
      this.pool = undefined;
      // Destroy only the owned connection, then wait for the query and disposal.
      item.disposal = pool.end({ timeout: 0 });
    }
  }

  private makePool(): Sql {
    // Parsed options retain dynamic passwords, multi-host selection, SSL and sockets.
    const parsed = this.parent.options as typeof this.parent.options & {
      shared: { retries: number; typeArrayMap: Record<string, unknown> };
      parameters: Record<string, string>;
      max_pipeline: number;
    };
    const serverDeadline = Math.max(1, Math.floor(this.config.deadlineMs / 2));
    return postgres({
      ...parsed,
      shared: { retries: 0, typeArrayMap: { ...parsed.shared.typeArrayMap } },
      parameters: {},
      max: 1, max_pipeline: 1, prepare: false, fetch_types: false,
      connect_timeout: Math.min(parsed.connect_timeout, this.config.deadlineMs / 4000),
      idle_timeout: this.config.idleTimeoutMs / 1000,
      debug: false, onnotice: () => {}, onparameter: undefined, onclose: () => this.active?.connectionLost?.(),
      connection: {
        ...parsed.connection,
        statement_timeout: timeoutCeiling(parsed.connection.statement_timeout, serverDeadline),
        lock_timeout: timeoutCeiling(parsed.connection.lock_timeout, serverDeadline),
      },
    } as unknown as postgres.Options<{}>);
  }

  private async drain(): Promise<void> {
    if (this.active) return;
    while (this.queue.length) {
      const item = this.queue.shift()!;
      this.active = item;
      // Pool disposal may outlive the previous queue item; never overlap sessions.
      await this.idleDisposal;
      this.idleDisposal = undefined;
      if (item.expired || performance.now() >= item.expiresAt) {
        if (!item.expired) {
          clearTimeout(item.timer);
          item.reject(new PgOperationError("deadline"));
        }
        this.active = undefined;
        continue;
      }
      item.started = true;
      let failure: PgOperationCategory | undefined;
      let result: unknown;
      try {
        const sql = this.pool ?? (this.pool = this.makePool());
        result = await item.execute(sql, item);
      } catch (error) {
        failure = error instanceof PgOperationError ? error.category : category(error);
      } finally {
        clearTimeout(item.timer);
        if ((failure || item.expired) && this.pool) {
          const pool = this.pool;
          this.pool = undefined;
          item.disposal = pool.end({ timeout: 0 });
        }
        try { await item.disposal; } catch { failure = "connection"; }
        if (item.expired || failure) item.reject(new PgOperationError(item.expired ? "deadline" : failure!));
        else item.resolve(result);
        this.active = undefined;
      }
    }
    this.idleTimer = setTimeout(() => {
      if (this.active || this.queue.length || !this.pool) return;
      const pool = this.pool;
      this.pool = undefined;
