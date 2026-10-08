/**
 * Display-only mirror of the send worker's overnight quiet window.
 *
 * The X send worker (apps/x-intern/src/workers/send.ts) already defers any
 * auto-send whose fire time lands inside the `[start,end)` UTC quiet window —
 * a 24/7 flat cadence is a bot signature, so nothing posts overnight. The
 * dashboard, however, still rendered a stamped-but-held target as "overdue"
 * once its clock passed, which reads as a stall and tempts the operator into
 * disabling the very protection keeping the account safe.
 *
 * These helpers let the dashboard label that state honestly ("holds till
 * HH:MM · quiet hours") instead. They are READ-ONLY and touch no network, DB,
 * or send path — purely presentational. Time is passed in as an argument so
 * they stay pure + deterministic (unit-testable, hydration-safe: the caller
 * computes only after mount).
 *
 * The hours mirror the server AUTOSEND_QUIET_START_UTC / AUTOSEND_QUIET_END_UTC
 * (default 4–12 UTC); the client copies are cosmetic and non-secret.
 */
export const QUIET_START_HOUR_UTC = Number(
  process.env.NEXT_PUBLIC_AUTOSEND_QUIET_START_UTC ?? 4,
);
export const QUIET_END_HOUR_UTC = Number(
  process.env.NEXT_PUBLIC_AUTOSEND_QUIET_END_UTC ?? 12,
);

/**
 * If `nowMs` is inside the `[startHourUtc, endHourUtc)` UTC quiet window,
 * return the epoch-ms when quiet next ends; else null. Supports a wrapping
 * window (e.g. 22→6). `startHourUtc === endHourUtc` => null (quiet disabled).
 */
export function quietHoldEndMs(
  nowMs: number,
  opts: { startHourUtc: number; endHourUtc: number },
): number | null {
  const { startHourUtc, endHourUtc } = opts;
  if (startHourUtc === endHourUtc) return null;
  const hour = new Date(nowMs).getUTCHours();
  const inside =
    startHourUtc < endHourUtc
      ? hour >= startHourUtc && hour < endHourUtc
      : hour >= startHourUtc || hour < endHourUtc;
  if (!inside) return null;
  const d = new Date(nowMs);
  const target = new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), endHourUtc, 0, 0, 0),
  );
  if (target.getTime() <= nowMs) target.setUTCDate(target.getUTCDate() + 1);
  return target.getTime();
}

/** Wall-clock "HH:MM" for a quiet-window end. Locale/timezone-dependent, so
 * callers must only render it after mount (hydration-safe). */
export function fmtQuietClock(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}
