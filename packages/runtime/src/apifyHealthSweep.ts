import type { Sql } from "postgres";
import type { ApifyAccountUsageHealth } from "./apifyUsage.js";
import type { ApifyUsageSaveResult } from "./apifyUsageDb.js";
import { withApifyCredentialDb, type ApifyCredentialClaim } from "./apifyPoolDb.js";

/**
 * Probe active Apify credentials, including parked spares and cooldowns. Only
 * definitive 401 receipts for the same current stored key can mark it invalid.
 * Account health and usage share one bounded check; unavailable readings leave
 * credentials unchanged. Each host schedules its own sweep of the shared pool.
 */

/** A token to probe: its connections row id + the secret value. */
export interface SweepToken {
  credentialId: string;
  token: string;
}

export interface ApifyHealthSweepDeps {
  sql: Sql;
  orgId: string;
  /**
   * List the org's ACTIVE apify tokens (in-use + parked spares) that aren't
   * already flagged invalid — the candidates worth probing.
   */
  listTokens: (sql: Sql, orgId: string) => Promise<SweepToken[]>;
  /** Probe one token's health (Apify /v2/users/me/limits). Must not throw on a 401. */
  checkToken: (token: string) => Promise<ApifyAccountUsageHealth>;
  /** Save a successful provider balance; failures never replace the last snapshot. */
  persistUsage?: (
    sql: Sql,
    orgId: string,
    credentialId: string,
    health: ApifyAccountUsageHealth,
  ) => Promise<ApifyUsageSaveResult | void>;
  /** Persist the invalid flag for a confirmed-dead token (idempotent). */
  markInvalid: (sql: Sql, claim: ApifyCredentialClaim) => Promise<boolean>;
  /**
   * Retire the org's already-flagged-invalid tokens, returning how many left the
   * active pool. Preserve their rows so spend and token identity remain linked.
   *
   * Optional: omit it and the sweep only FLAGS, exactly as before. Supplied, it
   * runs first, so invalid rows leave the active pool on the following sweep.
   *
   * Retiring on the NEXT sweep rather than the same one is deliberate: it leaves
   * a full sweep interval where the row is visibly `invalid`, so a mass die-off
   * is observable before it leaves the active pool.
   */
  pruneInvalid?: (sql: Sql, orgId: string) => Promise<number>;
  /** Max concurrent probes (keep low — gentle on the management API from one IP). */
  concurrency: number;
  log: { info: (o: object, m: string) => void; warn: (o: object, m: string) => void };
}

export interface ApifyHealthSweepResult {
  /** How many already-invalid rows this sweep retired (0 when pruning is off). */
  pruned: number;
  /** Tokens probed this sweep. */
  checked: number;
  /** Tokens flipped to `invalid` (definitive 401). */
  invalidated: number;
  /** Tokens that came back alive (200) — fresh or capped, left as-is. */
  alive: number;
  /** Unresolved probes or unacknowledged current-key writes; credentials stay unchanged. */
  inconclusive: number;
}

/**
 * Probe every active token and flag the definitively-dead (401) ones invalid.
 * Fail-open per token: a probe that throws or returns a non-401 failure is counted
 * inconclusive and the token is left untouched — we only ever retire on a 401.
 */
export async function sweepApifyTokenHealth(
  deps: ApifyHealthSweepDeps,
): Promise<ApifyHealthSweepResult> {
  const { sql, orgId, listTokens, checkToken, markInvalid, log } = deps;

  // Retire first: deactivate rows a PREVIOUS sweep already proved dead. Doing it
  // here rather than at flag time leaves one full interval where the row is
  // visibly `invalid`, so a mass die-off is observable before cleanup. Fail-soft
  // — a failed prune must never stop the probing below.
  let pruned = 0;
  if (deps.pruneInvalid) {
    pruned = await withApifyCredentialDb(sql, (connection) => deps.pruneInvalid!(connection, orgId)).catch((err) => {
      log.warn({ orgId, err: (err as Error).message }, "apify prune failed (ignored)");
      return 0;
    });
    if (pruned > 0) log.info({ orgId, pruned }, "apify: retired tokens confirmed dead earlier; spend retained");
  }

  const tokens = await withApifyCredentialDb(sql, (connection) => listTokens(connection, orgId));
  if (tokens.length === 0) {
    return { pruned, checked: 0, invalidated: 0, alive: 0, inconclusive: 0 };
  }

  const limit = Number.isFinite(deps.concurrency)
    ? Math.min(16, Math.max(1, Math.floor(deps.concurrency))) : 1;
  let invalidated = 0;
  let alive = 0;
  let inconclusive = 0;

  // Bounded-concurrency probe loop (no shard.ts dependency so this stays a small,
  // self-contained, easily-tested unit).
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next++;
      if (i >= tokens.length) return;
      const t = tokens[i]!;
      let health: ApifyAccountUsageHealth;
      try {
        health = await checkToken(t.token);
      } catch {
        inconclusive += 1; // probe threw → can't trust it → never kill
        continue;
      }
      if (health.alive) {
        alive += 1;
        if (
          deps.persistUsage && typeof health.monthlyUsageUsd === "number"
          && Number.isFinite(health.monthlyUsageUsd) && health.monthlyUsageUsd >= 0
        ) {
          try {
            const saved = await withApifyCredentialDb(sql, (connection) =>
              deps.persistUsage!(connection, orgId, t.credentialId, health));
            if (saved && !saved.saved && saved.reason !== "stale_fetch") {
              log.warn({ orgId, credentialId: t.credentialId, reason: saved.reason }, "apify usage snapshot was not saved");
            }
          } catch (err) {
            log.warn(
              { orgId, credentialId: t.credentialId, err: err instanceof Error ? err.message : String(err) },
              "apify usage snapshot failed (health sweep continues)",
            );
          }
        }
        continue;
      }
      if (health.httpStatus === 401) {
        try {
          const changed = await markInvalid(sql, { orgId, credentialId: t.credentialId, token: t.token });
          if (changed) invalidated += 1;
          else inconclusive += 1;
        } catch {
          // DB write failed — don't count it as invalidated; next sweep retries.
          inconclusive += 1;
        }
        continue;
      }
      inconclusive += 1; // 403 cap / 429 / 5xx / 0 — not a kill signal
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, tokens.length) }, () => worker()));

  const result = { pruned, checked: tokens.length, invalidated, alive, inconclusive };
  if (invalidated > 0) {
    log.warn({ orgId, ...result }, "apify health sweep marked confirmed dead tokens invalid");
  } else if (inconclusive > 0) {
    log.info({ orgId, ...result }, "apify health sweep completed with inconclusive readings");
  } else {
    log.info({ orgId, ...result }, "apify health sweep: all checked tokens alive");
  }
  return result;
}

export interface ThrottledApifyHealthSweep {
  (orgId: string): Promise<ApifyHealthSweepResult | null>;
  /** Supply the complete current worker roster, never a page or partial list. */
  reconcileOrganizations(orgIds: Iterable<string>): void;
}

/**
 * Per-process throttle. Null means the organization is already running or its
 * completed sweep is still within the interval; it is not a health result.
 * Reconciliation bounds retained state by the current roster plus executing
 * claims. Separate worker processes keep independent schedules.
 */
export function createThrottledApifyHealthSweep(opts: {
  intervalMs: number;
  run: (orgId: string) => Promise<ApifyHealthSweepResult>;
  /** Injectable clock (defaults to Date.now) so tests don't sleep. */
  now?: () => number;
}): ThrottledApifyHealthSweep {
  const now = opts.now ?? Date.now;
  const state = new Map<string, { running: boolean; retained: boolean; completedAt: number | undefined }>();
  const run = async (orgId: string): Promise<ApifyHealthSweepResult | null> => {
    const previous = state.get(orgId);
    if (previous?.running) return null;
    if (previous?.completedAt !== undefined && now() - previous.completedAt < opts.intervalMs) return null;

    const claim = { running: true, retained: true, completedAt: undefined as number | undefined };
    state.set(orgId, claim);
    try {
      const result = await opts.run(orgId);
      claim.completedAt = now();
      return result;
    } finally {
      claim.running = false;
      // A failed run retries immediately. A removed org's old completion must
      // not repopulate state after the latest roster reconciliation.
      if (!claim.retained || claim.completedAt === undefined) state.delete(orgId);
