import type { Sql } from "postgres";
import { BoundedPgSession } from "./boundedPgSession.js";

const sessions = new WeakMap<Sql, BoundedPgSession>();

/** Admission and receipt queries use one bounded session; provider calls stay outside it. */
export function withApifyCredentialDb<T>(parent: Sql, operation: (sql: Sql) => Promise<T>): Promise<T> {
  let session = sessions.get(parent);
  if (!session) {
    session = new BoundedPgSession(parent, {
      deadlineMs: 3000,
      maxPending: 32,
      idleTimeoutMs: 1000,
    });
    sessions.set(parent, session);
  }
  return session.run(operation);
}

export interface ApifyCredentialClaim {
  orgId: string;
  credentialId: string;
  /** Exact stored value used by the completed provider probe. */
  token: string;
}

export interface ActiveConnection { id: string; secret: string }
export interface ApifyTokenRow {
  credentialId: string;
  token: string;
  wasExhausted: boolean;
  /** Cooling tokens remain in the pool count but are skipped for actor calls. */
  available: boolean;
}
export interface SweepCandidate { credentialId: string; token: string }

/** Read an active credential for the selected org and kind. */
export async function getActiveConnection(
  sql: Sql, args: { orgId: string; kind: string },
): Promise<ActiveConnection | null> {
  const rows = await sql<ActiveConnection[]>`
    select id, secret from noelle.connections
    where org_id = ${args.orgId} and kind = ${args.kind} and active
    limit 1
  `;
  return rows[0] ?? null;
}

/** In-use, active pool; keep cooling rows for the resolver's exact total count. */
export async function listApifyTokens(sql: Sql, orgId: string): Promise<ApifyTokenRow[]> {
  const rows = await sql<Array<{ id: string; secret: string; exhausted: boolean; available: boolean }>>`
    select id, secret, (exhausted_at is not null) as exhausted,
      (invalid_at is null and (exhausted_at is null or retry_at <= now())) as available
    from noelle.connections
    where org_id = ${orgId} and kind = 'apify' and active and in_use and invalid_at is null
    order by (invalid_at is null and (exhausted_at is null or retry_at <= now())) desc,
      exhausted_at asc nulls first, created_at asc
  `;
  return rows.map(row => ({
    credentialId: row.id, token: row.secret,
    wasExhausted: row.exhausted, available: row.available,
  }));
}

/** Probe active tokens including parked spares and cooldowns, excluding known invalids. */
export async function listApifyTokensForHealthSweep(sql: Sql, orgId: string): Promise<SweepCandidate[]> {
  const rows = await sql<Array<{ id: string; secret: string }>>`
    select id, secret from noelle.connections
    where org_id = ${orgId} and kind = 'apify' and active and invalid_at is null
    order by created_at asc
  `;
  return rows.map(row => ({ credentialId: row.id, token: row.secret }));
}

/** Retain the credential row so labels and spend attribution survive retirement. */
export async function pruneInvalidApifyTokens(sql: Sql, orgId: string): Promise<number> {
  const rows = await sql<{ id: string }[]>`
    update noelle.connections set active = false, in_use = false, updated_at = now()
    where org_id = ${orgId} and kind = 'apify' and active and invalid_at is not null
    returning id
  `;
  return rows.length;
}

/** A completed 401 can invalidate only the same active organization and stored key. */
export async function markApifyTokenInvalid(parent: Sql, claim: ApifyCredentialClaim): Promise<boolean> {
  return withApifyCredentialDb(parent, async sql => sql.begin(async tx => {
    await tx`set local lock_timeout = '1s'`;
    await tx`set local statement_timeout = '2s'`;
    await tx`set local idle_in_transaction_session_timeout = '3s'`;
    // Acquire before dispatching a mutation. Closing a timed-out autocommit
    // UPDATE socket does not guarantee PostgreSQL cancels its lock wait.
    const rows = await tx<{ id: string }[]>`
      select id from noelle.connections
      where id = ${claim.credentialId} and org_id = ${claim.orgId}
        and kind = 'apify' and active and secret = ${claim.token} and invalid_at is null
      for no key update
    `;
    if (rows.length !== 1) return false;
    await tx`update noelle.connections set invalid_at = now(), updated_at = now() where id = ${claim.credentialId}`;
    return true;
  }));
}

/** Some consumers preserve updated_at when a healthy token has no flags to clear. */
export async function clearApifyTokenExhausted(
  sql: Sql, credentialId: string, opts: { onlyIfFlagged?: boolean } = {},
): Promise<void> {
  await sql`
    update noelle.connections
    set exhausted_at = null, retry_at = null, invalid_at = null, updated_at = now()
    where id = ${credentialId} and kind = 'apify'
      and (${opts.onlyIfFlagged ?? false} = false or exhausted_at is not null or invalid_at is not null)
  `;
}

/** Fallback cooldown when the token's billing-cycle reset is unknown. */
export const DEFAULT_RETRY_COOLDOWN_DAYS = 30;

export interface MarkExhaustedOpts {
  /** Measured billing-cycle reset; takes precedence over the fallback duration. */
  retryAt?: Date;
  /** Fallback duration when the billing-cycle reset is unavailable. */
  cooldownDays?: number;
}

/**
 * Start a cooldown for a fresh token or renew one after its retry time has passed.
 * An active future cooldown keeps its original timestamps, including when two
 * failed attempts update the same credential concurrently.
 */
export async function markApifyTokenExhausted(
  sql: Sql,
  credentialId: string,
  opts: MarkExhaustedOpts = {},
): Promise<void> {
  const retryAt =
    opts.retryAt ??
    new Date(Date.now() + (opts.cooldownDays ?? DEFAULT_RETRY_COOLDOWN_DAYS) * 24 * 60 * 60 * 1000);
  await sql`
    update noelle.connections
    set exhausted_at = now(),
        retry_at = ${retryAt},
        updated_at = now()
    where id = ${credentialId} and kind = 'apify'
      and (exhausted_at is null or retry_at <= now())
  `;
}
