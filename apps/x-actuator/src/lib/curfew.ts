// Single source of truth for the overnight WRITE curfew — the local
// [CURFEW_START_HOUR, CURFEW_END_HOUR) band during which the actuator performs
// no writes at all. Every enforcement point (the runtime write floor in
// tickOnce, the idle-like slot, the scheduler's plan-time avoidance) reads this,
// so the whole actuator opens or closes as one.
//
// LIKES ARE INCLUDED. They were originally exempt, on the theory that likes are
// low-risk and keep the session looking alive. In practice that meant a run
// started with the overnight curfew ON still sat there liking at 2am, which is
// the exact "asleep but active" signature the curfew exists to avoid — and it
// made the curfew look broken to the operator, because the panel said
// "overnight pause" while the like counter kept moving. A curfew that pauses
// only some writes is not a curfew. Ambient BROWSING (reads) still continues:
// that is what keeps the session warm without leaving a public trace.
//
// The GLOBAL default is DISABLED: writes are allowed at ANY hour for MANUAL runs
// ("Run" and "Drain all approvals"), because the operator chose that hour and is
// present — "I write at whatever hour". The per-run `enabled` flag turns it ON
// for the UNATTENDED, set-and-forget paths — the "Full automatic" button and the
// autonomy auto-start/auto-drain — so those never post while the operator is
// asleep.
export const WRITE_CURFEW_ENABLED = false; // global default for callers passing no flag
export const CURFEW_START_HOUR = 1; // inclusive lower bound (local hour)
export const CURFEW_END_HOUR = 9; // exclusive upper bound (local hour)

// True when a WRITE (a reply, a DM, or a LIKE) at `atMs` (operator-local time)
// falls inside the curfew band AND the curfew is enabled for this run. `enabled`
// defaults to the global switch, so existing single-arg callers keep their
// (disabled) behavior. Handles a same-day window (START < END, e.g. 1→9 ⇒ held
// 01:00–08:59) and one that wraps midnight (START > END, e.g. the 23→6 band this
// actuator shipped with ⇒ held 23:00–05:59).
export function isWriteCurfew(atMs: number, enabled: boolean = WRITE_CURFEW_ENABLED): boolean {
  if (!enabled) return false;
  const h = new Date(atMs).getHours();
  return CURFEW_START_HOUR < CURFEW_END_HOUR
    ? h >= CURFEW_START_HOUR && h < CURFEW_END_HOUR
    : h >= CURFEW_START_HOUR || h < CURFEW_END_HOUR;
}
