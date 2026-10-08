/**
 * Server-side working-hours floor for the LinkedIn actionable queue. Backstops
 * the extension's 23:00-06:00 client curfew (linkedin-actuator/src/lib/scheduler.ts):
 * a wrong-clock/DST/tampered client must never make the api-vm serve writes
 * outside believable hours. Pure + deterministic (nowMs passed in) so it unit-tests
 * cleanly. Mirrors linkedin-intern/src/lib/cadence.ts:withinActiveHours.
 *
 * start===end (incl. the default 0,0 when unset) => disabled / 24h open.
 * Window may wrap past midnight (e.g. start=22, end=6).
 *
 * NOTE: the tz offset is a FIXED minutes-from-UTC value; it does NOT follow DST.
 * This is a coarse backstop, not a precise scheduler — set the window conservatively.
 */
export function withinSendWindow(
  nowMs: number,
  startHour: number,
  endHour: number,
  tzOffsetMin: number,
): boolean {
  if (startHour === endHour) return true; // disabled / 24h
  const localHour = new Date(nowMs + tzOffsetMin * 60_000).getUTCHours();
  return startHour < endHour
    ? localHour >= startHour && localHour < endHour
    : localHour >= startHour || localHour < endHour; // wraps midnight
}

/** True only if a start/end is configured (either env var present). */
export function sendWindowConfigured(startRaw?: string, endRaw?: string): boolean {
  return (startRaw ?? "") !== "" || (endRaw ?? "") !== "";
}

/**
 * Validate a configured window; invalid config => caller must fail CLOSED.
 * start must be an integer in 0-23; end an integer in 0-24 (24 maps to midnight
 * via the wrap logic); tz a finite integer. Any NaN (e.g. a set START with an
 * unset END that coerces to NaN) returns false so partial config never falls
 * through to a silent half-open window.
 */
export function sendWindowValid(startHour: number, endHour: number, tzOffsetMin: number): boolean {
  return (
    Number.isInteger(startHour) && startHour >= 0 && startHour <= 23 &&
    Number.isInteger(endHour) && endHour >= 0 && endHour <= 24 &&
    Number.isInteger(tzOffsetMin)
  );
}

/** Default tz offset: UTC-5 (matches NOELLE_LINKEDIN_TZ_OFFSET_MIN's documented default). */
export const DEFAULT_TZ_OFFSET_MIN = -300;

/**
 * Parse an hour env value. An unset OR empty-string bound yields NaN — never 0 —
 * so a partial window (only one bound set) can never coerce into a silent
 * half-open window. This is the trap the inline `Number(raw ?? 0)` parse fell into.
 */
function parseHour(raw?: string): number {
  return raw == null || raw === "" ? NaN : Number(raw);
}

export interface ResolvedSendWindow {
  configured: boolean;
  valid: boolean;
  startHour: number;
  endHour: number;
  tzOffsetMin: number;
}

/**
 * Resolve the raw env window config into a gate decision. PURE (reads no clock).
 * `configured && !valid` MUST be treated by the caller as fail-CLOSED (serve empty):
 * a partial or garbage window is a misconfiguration, not a licence to send 24h.
 */
export function resolveSendWindow(
  startRaw?: string,
  endRaw?: string,
  tzRaw?: string,
): ResolvedSendWindow {
  const configured = sendWindowConfigured(startRaw, endRaw);
  const startHour = parseHour(startRaw);
  const endHour = parseHour(endRaw);
  const tzOffsetMin =
    tzRaw == null || tzRaw === "" ? DEFAULT_TZ_OFFSET_MIN : Number(tzRaw);
  const valid = sendWindowValid(startHour, endHour, tzOffsetMin);
  return { configured, valid, startHour, endHour, tzOffsetMin };
}
