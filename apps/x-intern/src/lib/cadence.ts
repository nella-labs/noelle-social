import type { Env } from "../env.js";

/**
 * Human-hours gate for the X-touching discovery/profiler workers.
 *
 * Ported from Lyra. Activity at 3am in a tight loop is one of the clearest bot
 * signals, and docs/x-account-safety.md names velocity + round-the-clock
 * behaviour as the #1 lock trigger — so these workers only reach X during the
 * operator's waking window.
 *
 * NOTE this is the READ side. The actuator already has its own write-curfew for
 * posting; this covers the scraping half, which previously ran 24/7 regardless.
 * Uses an explicit UTC offset (not the server's TZ) so it is deterministic and
 * testable.
 *
 * START==END disables the gate (runs 24h) — the default, so this ships inert.
 * The window may wrap past midnight (e.g. START=22, END=6).
 */
export function withinActiveHours(
  env: Pick<Env, "X_ACTIVE_HOURS_START" | "X_ACTIVE_HOURS_END" | "X_TZ_OFFSET_MIN">,
  nowMs: number = Date.now(),
): boolean {
  const start = env.X_ACTIVE_HOURS_START;
  const end = env.X_ACTIVE_HOURS_END;
  if (start === end) return true; // disabled / 24h
  const localHour = new Date(nowMs + env.X_TZ_OFFSET_MIN * 60_000).getUTCHours();
  return start < end
    ? localHour >= start && localHour < end
    : localHour >= start || localHour < end; // wraps past midnight
}
