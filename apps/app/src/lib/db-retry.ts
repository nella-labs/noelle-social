/**
 * Connection-error classifier for the DB self-heal retry (see ./db.ts).
 *
 * Split into its own module (no `next/headers` import) so the load-bearing
 * retry timing is unit-testable without native connector imports. Callers must
 * restrict retries to acquisition or PostgreSQL-enforced read-only dispatches.
 *
 * Why a retry exists at all: the Cloud SQL Node connector refreshes its 1-hour
 * ephemeral client cert on a background setTimeout
 * (GH cloud-sql-nodejs-connector#285). Vercel freezes the function instance
 * between requests, suspending that timer — so a warm-but-idle instance reuses
 * an EXPIRED cert and Cloud SQL rejects the mTLS handshake with TLS alert 42
 * ("bad certificate"). With `max:1` + a per-instance singleton + no retry, that
 * one poisoned instance then 500s every request until it recycles.
 */

/**
 * Is this a connection/TLS-class failure?
 *
 * Connection failure alone never proves whether a dispatched write committed.
 * This classifier is suitable for acquisition; dispatched writes must not use it.
 */
export function isRetryableConnError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { severity?: unknown; code?: unknown; message?: unknown };
  if (e.severity) return false; // server-side PostgresError — never replay
  const code = String(e.code ?? "");
  if (
    [
      "CONNECTION_DESTROYED",
      "CONNECTION_CLOSED",
      "CONNECTION_ENDED",
      "CONNECT_TIMEOUT",
      "ECONNRESET",
      "ECONNREFUSED",
      "EPIPE",
      "ETIMEDOUT",
    ].includes(code) ||
    code.startsWith("ERR_SSL")
  ) {
    return true;
  }
  return /bad certificate|SSL alert number 42|ERR_SSL|\btls\b|ECONNRESET|connection (closed|ended|destroyed|terminated|timeout)/i.test(
    String(e.message ?? ""),
  );
}

/** A READ ONLY transaction cannot commit product writes, including on server disconnect. */
export function isRetryableReadError(err: unknown): boolean {
  if (isRetryableConnError(err)) return true;
  if (!err || typeof err !== "object") return false;
  const code = String((err as { code?: unknown }).code ?? "");
  return code.startsWith("08") || ["57P01", "57P02", "57P03"].includes(code);
}

/**
 * A bounded-wait timeout, shaped as a retryable connection error.
 *
 * Why this exists: the Cloud SQL connector acquires its 1-hour ephemeral client
 * cert AND the WIF/OIDC federated access token on a path with no timeout of its
 * own (`Connector#getOptions` + the google-auth-library token exchange). When
 * Vercel freezes the connector's background cert-refresh timer (GH
 * cloud-sql-nodejs-connector#285) — or a token-exchange HTTP call stalls — the
 * CLIENT BUILD hangs with no error thrown. postgres.js's `connect_timeout` /
 * `statement_timeout` can't help: they only bound a client that already exists.
 * An unbounded build freezes EVERY DB-backed request on that warm function
 * instance — server actions, `router.refresh()` re-renders, and the nav spend
 * poll all stick "pending" for minutes until the instance recycles, which reads
 * to the user as "no button does anything; I have to reload to see changes."
 *
 * Giving the timeout the `CONNECT_TIMEOUT` code makes `isRetryableConnError`
 * retry a stalled acquisition. Its owner closes the unpublished connector;
 * a dispatched query deadline never implies that a write can be replayed.
 */
export class DbTimeoutError extends Error {
  readonly code = "CONNECT_TIMEOUT";
  constructor(label: string, ms: number) {
    super(`${label} timed out after ${ms}ms`);
    this.name = "DbTimeoutError";
  }
}

/**
 * Reject with a retryable {@link DbTimeoutError} if `p` doesn't settle within
 * `ms`. The loser of the race keeps running (a JS promise can't be cancelled),
 * so acquisition owners must dispose late unpublished resources. Dispatched
 * mutations must remain uncertain rather than being replayed after this race.
 */
export function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new DbTimeoutError(label, ms)), ms);
  });
  return Promise.race([p, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

export interface RetryOpts {
  /** Clean up only resources owned by this replay-safe phase before a retry. */
  reset: () => void | Promise<void>;
  /** Per-attempt wall-clock budget. Omit to leave attempts unbounded. */
  timeoutMs?: number;
  /** Backoff (ms) before each retry; its length sets the retry count. */
  backoffMs?: number[];
  /** Override the retryable-error classifier (defaults to connection-class). */
  isRetryable?: (err: unknown) => boolean;
  /** Label used in the timeout error message. */
  label?: string;
}

/**
 * Execute a replay-safe `attempt`: on a
 * connection/TLS error OR a per-attempt timeout (NOT a server PostgresError),
 * call `reset()` and retry. Capped at `backoffMs.length`
 * retries so a genuinely-down DB still fails fast to the route error boundary
 * instead of hanging the render.
 *
 * Lives here (not db.ts, which can't be imported under test — it pulls in
 * `next/headers` + the native connector) so the load-bearing retry/timeout
 * behaviour is unit-testable in isolation.
 */
export async function runWithRetry<T>(
  attempt: () => Promise<T>,
  opts: RetryOpts,
): Promise<T> {
  const isRetryable = opts.isRetryable ?? isRetryableConnError;
  const backoffMs = opts.backoffMs ?? [150, 500];
  const label = opts.label ?? "db attempt";
  for (let i = 0; ; i++) {
    try {
      const p = attempt();
      return opts.timeoutMs ? await withTimeout(p, opts.timeoutMs, label) : await p;
    } catch (err) {
      if (i >= backoffMs.length || !isRetryable(err)) throw err;
      await opts.reset();
      await new Promise((r) => setTimeout(r, backoffMs[i] + Math.floor(Math.random() * 50)));
    }
  }
}
