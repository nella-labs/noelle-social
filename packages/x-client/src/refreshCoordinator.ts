// Cross-process OAuth2 refresh coordinator (RC1 + RC2).
//
// X OAuth2 refresh tokens are SINGLE-USE: each refresh rotates the refresh token
// (RT) and invalidates the previous one. Three Noelle processes refresh the same
// account's token — the send worker, the content-publish worker, and the manual
// POST /api/drafts/:id/send route. Without coordination, two that refresh near
// the ~2h expiry both read the same RT; the first rotates + persists and the
// second then posts the now-dead RT → X returns
//   invalid_request: "Value passed for the token was invalid"
// and the chain breaks permanently.
//
// This wraps the refresh in a Postgres transaction guarded by a per-account
// advisory lock, so only ONE process calls X at a time. A process that loses the
// race re-reads the freshly-persisted token and skips the X call entirely.

import { XAuthError } from "./errors.js";
import type { PerformHttpRefresh, RefreshCoordinator, XApiTokens } from "./apiClient.js";

/**
 * The minimal postgres.js surface the coordinator needs: a transaction runner.
 * A real `Sql` (postgres.js) satisfies this structurally, so callers pass their
 * client unchanged. `tx` is deliberately untyped (`any`): postgres.js's
 * tagged-template client can't be described by a plain structural interface (its
 * `Helper` overload carries a private `then`), and template SQL arguments aren't
 * type-checked anyway.
 */
export interface RefreshDbClient {
  begin<T>(cb: (tx: any) => Promise<T>): Promise<T>;
}

/** Minimal logger surface (pino- or console-shaped). */
export interface RefreshLogger {
  error: (obj: unknown, msg?: string) => void;
}

const defaultLogger: RefreshLogger = {
  error: (obj, msg) => console.error(msg ?? "x_api refresh error", obj),
};

interface TokenRow {
  access_token: string;
  refresh_token: string | null;
  access_token_expires_at: string | null;
}

/**
 * Build a {@link RefreshCoordinator} bound to one agent instance + Postgres
 * client. Pass the result as `createXApiClient({ refreshCoordinator })`.
 *
 * Inside a single transaction it:
 *   1. takes a per-account `pg_advisory_xact_lock` (serializes all refreshers;
 *      xact-scoped, so it auto-releases on commit/rollback),
 *   2. re-reads the token row `for update`,
 *   3. if the stored token still has > 30s of life, RETURNS it and skips X — a
 *      sibling process refreshed while we waited on the lock,
 *   4. otherwise calls X ONCE with the CURRENT DB refresh token, persists the
 *      rotation (coalescing RT + expiry so a response missing either never wipes
 *      the stored value), and returns the fresh tokens.
 *
 * Holding the lock across the ~200ms X call is intentional — that serialization
 * is the whole point, and refresh is a low-frequency (~once / 2h) operation. If
 * the persist UPDATE throws, we log a DISTINCT message before rethrowing, because
 * a lost rotation is otherwise silent (RC1).
 */
export function makeRefreshCoordinator(
  sql: RefreshDbClient,
  agentInstanceId: string,
  log: RefreshLogger = defaultLogger,
): RefreshCoordinator {
  const lockKey = `x_api_refresh:${agentInstanceId}`;
  return async (performHttpRefresh: PerformHttpRefresh): Promise<XApiTokens> => {
    return sql.begin(async (tx) => {
      await tx`select set_config('lock_timeout', '5s', true), set_config('statement_timeout', '10s', true)`;
      // 1. Serialize every refresher for this account. xact-scoped: released
      //    automatically when this transaction commits or rolls back.
      await tx`select pg_advisory_xact_lock(hashtext(${lockKey}))`;

      // 2. Re-read under the lock (row lock too, belt-and-suspenders).
      const rows = (await tx`
        select access_token, refresh_token, access_token_expires_at
        from noelle.x_api_tokens
        where agent_instance_id = ${agentInstanceId}
        for update
      `) as TokenRow[];
      const row = rows[0];
      if (!row) throw new XAuthError(`x_api refresh: no token row for ${agentInstanceId}`);

      // 3. A sibling already refreshed while we waited → reuse it, skip the X
      //    call (this is what makes the single-use RT safe under concurrency).
      const expMs = row.access_token_expires_at
        ? new Date(row.access_token_expires_at).getTime()
        : null;
      if (expMs != null && expMs - Date.now() > 30_000) {
        const reused: XApiTokens = { accessToken: row.access_token, expiresAt: expMs };
        if (row.refresh_token) reused.refreshToken = row.refresh_token;
        return reused;
      }

      if (!row.refresh_token) {
        throw new XAuthError(`x_api refresh: no refresh_token stored for ${agentInstanceId}`);
      }

      // 4. Refresh with the CURRENT DB token (never a stale in-memory one).
      const fresh = await performHttpRefresh(row.refresh_token);

      // Persist the rotation atomically. Coalesce so a response lacking a rotated
      // RT or expires_in never nulls the stored value.
      try {
        await tx`
          update noelle.x_api_tokens
             set access_token = ${fresh.accessToken},
                 refresh_token = coalesce(${fresh.refreshToken ?? null}, refresh_token),
                 access_token_expires_at = coalesce(
                   ${fresh.expiresAt ? new Date(fresh.expiresAt).toISOString() : null},
                   access_token_expires_at
                 )
           where agent_instance_id = ${agentInstanceId}
        `;
      } catch (e) {
        // RC1 — a lost rotation is otherwise silent. Shout, then roll back.
        log.error(
          { agentInstanceId, err: (e as Error).message },
          "x_api refresh rotation persist FAILED",
        );
        throw e;
      }

      return fresh;
    });
  };
}
