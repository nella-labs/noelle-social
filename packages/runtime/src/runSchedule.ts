import type { RunSchedule } from "@noelle/contracts";

// Next-fire math + fire/skip decision for the recurring scheduled run
// (0085_run_schedule.sql). Pure — no DB, no clock of its own (the caller passes
// `now`/`from`), so it's fully unit-testable. Uses native `Intl` for timezone
// arithmetic; no date library dependency.

// Wall-clock offset (local wall clock − UTC) in ms for `instant` in `timeZone`.
function tzOffsetMs(instant: Date, timeZone: string): number {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const parts = dtf.formatToParts(instant);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  let hour = get("hour");
  if (hour === 24) hour = 0; // some engines format midnight as "24"
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), hour, get("minute"), get("second"));
  return asUtc - instant.getTime();
}

// The UTC instant whose wall clock in `timeZone` is exactly y-mo-d hh:mm:00.
// Solves local = utc + offset(utc) by a guess + one DST-boundary refinement.
function wallClockToUtc(
  y: number,
  mo: number,
  d: number,
  hh: number,
  mm: number,
  timeZone: string,
): Date {
  const guess = Date.UTC(y, mo - 1, d, hh, mm, 0);
  const offset1 = tzOffsetMs(new Date(guess), timeZone);
  let utc = guess - offset1;
  const offset2 = tzOffsetMs(new Date(utc), timeZone);
  if (offset2 !== offset1) utc = guess - offset2;
  return new Date(utc);
}

// The wall-clock calendar date (y/mo/d) in `timeZone` at `instant`.
function wallClockDate(instant: Date, timeZone: string): { y: number; mo: number; d: number } {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const parts = dtf.formatToParts(instant);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  return { y: get("year"), mo: get("month"), d: get("day") };
}

/**
 * The next instant the schedule should fire, strictly after `from`. Returns null
 * for a disabled or structurally-incomplete schedule (fail-safe: an unfireable
 * schedule yields no next_at, so the scheduler simply never picks the row up).
 *
 *   - interval → `from` + intervalHours hours.
 *   - daily    → the next `HH:MM` in `timezone` after `from` (today if still
 *                upcoming, else the following day).
 */
export function computeNextRunAt(schedule: RunSchedule, from: Date): Date | null {
  if (!schedule.enabled) return null;

  if (schedule.mode === "interval") {
    if (schedule.intervalHours == null) return null;
    return new Date(from.getTime() + schedule.intervalHours * 3_600_000);
  }

  // daily
  if (!schedule.dailyTime) return null;
  const [hhStr, mmStr] = schedule.dailyTime.split(":");
  const hh = Number(hhStr);
  const mm = Number(mmStr);
  const tz = schedule.timezone;

  // Start from today's calendar date in the target tz and walk forward a day at
  // a time until the HH:MM instant lands strictly after `from`. Normally 1–2
  // iterations; the small cap is a guard against a pathological DST collapse.
  let { y, mo, d } = wallClockDate(from, tz);
  for (let i = 0; i < 4; i++) {
    const cand = wallClockToUtc(y, mo, d, hh, mm, tz);
    if (cand.getTime() > from.getTime()) return cand;
    // Advance the wall-clock date by one calendar day. Anchor at noon UTC so the
    // +24h step can never skip or repeat a date across a DST transition.
    const next = new Date(Date.UTC(y, mo - 1, d, 12, 0, 0) + 24 * 3_600_000);
    y = next.getUTCFullYear();
    mo = next.getUTCMonth() + 1;
    d = next.getUTCDate();
  }
  return null;
}

export interface ScheduledRunRow {
  /** Parsed run_schedule (parseRunSchedule); null when there's no schedule. */
  runSchedule: RunSchedule | null;
  /** goal_target is not null — a goal-run is already in flight. */
  goalActive: boolean;
}

export type ScheduledRunPlan =
  // Schedule is off/invalid: clear run_schedule_next_at, fire nothing.
  | { action: "clear" }
  // Due, but a run is already active: never stomp it — retry SHORTLY, same day.
  | { action: "skip"; nextAt: Date | null }
  // Due and idle: open a goal-run for `goal` (the Start-all writes) and set next_at.
  | { action: "fire"; goal: number; nextAt: Date | null };

/**
 * How long to wait before re-checking a slot that was busy.
 *
 * Whatever is running ends on its own — at its goal, or via the 2h stall
 * auto-pause — so a short retry gets the scheduled run its slot later the same
 * day instead of losing the day entirely.
 */
export const BUSY_RETRY_MS = 30 * 60_000;

/**
 * Decide what a DUE row (run_schedule_next_at <= now, selected by the scheduler
 * query) should do. Pure; the caller performs the DB write the plan implies.
 */
export function planScheduledRun(row: ScheduledRunRow, now: Date): ScheduledRunPlan {
  const s = row.runSchedule;
  if (!s || !s.enabled) return { action: "clear" };
  const nextAt = computeNextRunAt(s, now);

  // A run is already in flight. DEFER — do not roll next_at to tomorrow.
  //
  // Rolling forward loses the whole day, silently, and it is not a rare edge:
  // Lyra's runs habitually start at 00:0x (spilling over from the evening) or
  // are started by hand, so 08:00 almost never found her idle. Measured over
  // six weeks of approvals, exactly ONE of her scheduled 08:00 runs ever fired.
  //
  // Retry shortly instead. Whatever is running ends on its own — at its goal,
  // or via the 2h stall auto-pause — so the scheduled run gets its slot later
  // the same day. Deliberately NOT pre-empting: killing a run the operator
  // started by hand throws away work they asked for.
  //
  // The retry is capped at the next scheduled occurrence, so a run that never
  // ends degrades to the old behaviour (one attempt per cycle) instead of
  // deferring past the following slot and compounding.
  if (row.goalActive) {
    const retryAt = new Date(now.getTime() + BUSY_RETRY_MS);

    // SAME DAY, and the cap has to say so. Capping at the next occurrence is
    // not enough for a daily schedule: the next occurrence is TOMORROW, so a
    // run busy until 00:20 would let a daily-08:00 goal-run open at ~00:20 —
    // straight into the overnight hours the curfew work in this same change is
    // tightening. Give up at local midnight and let tomorrow's slot handle it.
    const { y, mo, d } = wallClockDate(now, s.timezone);
    const midnight = wallClockToUtc(y, mo, d + 1, 0, 0, s.timezone);

    // Past midnight means the day is over: stop deferring and hand it back to
    // the normal schedule (tomorrow's slot). Capping AT midnight would instead
    // re-evaluate at 00:00 and could fire right then — inside the night, which
    // is what the curfew work in this same change exists to prevent.
    if (retryAt.getTime() >= midnight.getTime()) {
      return { action: "skip", nextAt };
    }
    // An interval schedule whose next occurrence lands before the retry wins,
    // so a short interval is never delayed by the retry.
    const capped =
      nextAt != null && nextAt.getTime() <= retryAt.getTime() ? nextAt : retryAt;
    return { action: "skip", nextAt: capped };
  }

  return { action: "fire", goal: s.goal, nextAt };
}
