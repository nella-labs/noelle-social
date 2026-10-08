export type CronAuthDecision = { ok: true } | { ok: false; status: number; code: string };

/**
 * Decide whether a cron request may run. Pure + deterministic (no Date.now, no
 * process.env reads) so it is unit-testable; the route passes env in as args.
 *
 * Fail-closed contract:
 *  - CRON_SECRET set  -> require exact `Bearer <secret>` match (401 otherwise).
 *  - CRON_SECRET unset + production -> refuse (401) UNLESS allowUnauthenticated.
 *  - CRON_SECRET unset + non-production (dev) -> allow (local convenience).
 */
export function decideCronAuth(opts: {
  authHeader: string | null;
  cronSecret: string | undefined;
  isProduction: boolean;
  allowUnauthenticated: boolean;
}): CronAuthDecision {
  const { authHeader, cronSecret, isProduction, allowUnauthenticated } = opts;
  if (cronSecret) {
    return authHeader === `Bearer ${cronSecret}`
      ? { ok: true }
      : { ok: false, status: 401, code: "invalid_cron_secret" };
  }
  // No secret configured.
  if (isProduction && !allowUnauthenticated) {
    return { ok: false, status: 401, code: "cron_secret_unset" };
  }
  return { ok: true };
}
