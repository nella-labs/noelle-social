import type { Env } from "../env.js";

/**
 * Human-hours gate for LinkedIn-touching workers (discovery, profiler).
 *
 * Activity at 3am in a tight loop is one of the clearest bot signals, so we only
 * let those workers hit LinkedIn during the operator's waking window. Uses an
 * explicit UTC offset (not the server's TZ) so it's deterministic and testable.
 *
 * START==END disables the gate (runs 24h). The window may wrap past midnight
 * (e.g. START=22, END=6).
 */
export function withinActiveHours(
  env: Pick<Env, "LINKEDIN_ACTIVE_HOURS_START" | "LINKEDIN_ACTIVE_HOURS_END" | "LINKEDIN_TZ_OFFSET_MIN">,
  nowMs: number = Date.now(),
): boolean {
  const start = env.LINKEDIN_ACTIVE_HOURS_START;
  const end = env.LINKEDIN_ACTIVE_HOURS_END;
  if (start === end) return true; // disabled / 24h
  const localHour = new Date(nowMs + env.LINKEDIN_TZ_OFFSET_MIN * 60_000).getUTCHours();
  return start < end
    ? localHour >= start && localHour < end
    : localHour >= start || localHour < end; // wraps past midnight
}
