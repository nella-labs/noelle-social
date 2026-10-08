// Single source of truth for the overnight POSTING curfew — the local
// [CURFEW_START_HOUR, CURFEW_END_HOUR) band during which comments and DMs are
// held. Likes and ambient browsing still run; only the higher-risk POSTS pause.
// Every enforcement point (the runtime write floor in tickOnce, the scheduler's
// plan-time avoidance) reads this, so the whole actuator opens or closes as one.
//
// The GLOBAL default is DISABLED: writes are allowed at ANY hour for MANUAL runs
// ("Run" and "Drain all approvals"), because the operator chose that hour and is
// present — "I write at whatever hour". The per-run `enabled` flag turns it ON
// for the UNATTENDED, set-and-forget paths — the "Full automatic" button and the
// autonomy auto-start — so those never post while the operator is asleep.
export const WRITE_CURFEW_ENABLED = false; // global default for callers passing no flag
export const CURFEW_START_HOUR = 1; // inclusive lower bound (local hour)
export const CURFEW_END_HOUR = 9; // exclusive upper bound (local hour)

// True when a post (comment/DM) at `atMs` (operator-local time) falls inside the
// curfew band AND the curfew is enabled for this run. `enabled` defaults to the
// global switch, so existing single-arg callers keep their (disabled) behavior.
// Handles a same-day window (START < END, e.g. 1→9 ⇒ held 01:00–08:59) and one
// that wraps midnight (START > END, e.g. 23→6 ⇒ held 23:00–05:59).
export function isWriteCurfew(atMs: number, enabled: boolean = WRITE_CURFEW_ENABLED): boolean {
  if (!enabled) return false;
  const h = new Date(atMs).getHours();
  return CURFEW_START_HOUR < CURFEW_END_HOUR
    ? h >= CURFEW_START_HOUR && h < CURFEW_END_HOUR
    : h >= CURFEW_START_HOUR || h < CURFEW_END_HOUR;
}
