// Single source of truth for the overnight WRITE-curfew (reply/upvote) — the
// local [CURFEW_START_HOUR, CURFEW_END_HOUR) band. Every enforcement point (the
// scheduler's plan-time avoidance, the runtime write floor in tickOnce, and the
// idle-upvote gate) reads this, so the whole actuator opens or closes together.
//
// DISABLED by operator request: writes are allowed at ANY hour. The actuator only
// ticks while the operator's browser/extension is open (it is not a headless
// overnight bot), so there is no unattended overnight posting. To restore the
// overnight window, set WRITE_CURFEW_ENABLED = true (and/or narrow the two hours
// below).
export const WRITE_CURFEW_ENABLED = false;
export const CURFEW_START_HOUR = 23; // inclusive lower bound (local hour)
export const CURFEW_END_HOUR = 6; // exclusive upper bound (local hour)

// True when a write at `atMs` (operator-local time) falls inside the curfew band.
// Always false while the curfew is disabled, so no caller ever blocks or shifts a
// write for curfew.
export function isWriteCurfew(atMs: number): boolean {
  if (!WRITE_CURFEW_ENABLED) return false;
  const h = new Date(atMs).getHours();
  return h >= CURFEW_START_HOUR || h < CURFEW_END_HOUR;
}
