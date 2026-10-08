/**
 * Space selected replies by configured random gaps and move timestamps out of
 * quiet hours. The database owner accounts for existing schedules and budgets;
 * the send worker separately enforces its rate and account-state gates.
 * Pure and deterministic when the caller supplies the clock and random source.
 */
export interface AutoSendScheduleOpts {
  /** How many sends to lay out. */
  count: number;
  /** Base epoch ms the first gap is measured from (e.g. the request time). */
  startAtMs: number;
  /** Min seconds between consecutive sends. */
  minGapSec: number;
  /** Max seconds between consecutive sends (>= minGapSec). */
  maxGapSec: number;
  /** Overnight quiet window in UTC hours [start, end); sends inside are pushed to `end`. Omit to disable. */
  quietStartHourUtc?: number;
  quietEndHourUtc?: number;
  /** Injectable RNG in [0,1). Defaults to Math.random (callers in tests pass a seeded one). */
  rng?: () => number;
}

/** Is `ms` inside the [startHour, endHour) UTC quiet window? Supports wrap (e.g. 22→6). */
function inQuietWindow(ms: number, startHour: number, endHour: number): boolean {
  const hour = new Date(ms).getUTCHours();
  if (startHour === endHour) return false;
  if (startHour < endHour) return hour >= startHour && hour < endHour;
  // Wrapping window (e.g. 22:00→06:00): inside if after start OR before end.
  return hour >= startHour || hour < endHour;
}

/** Push `ms` to the next occurrence of `endHour:00:00` UTC (the end of quiet hours). */
function pushPastQuiet(ms: number, endHour: number): number {
  const d = new Date(ms);
  const target = new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), endHour, 0, 0, 0),
  );
  if (target.getTime() <= ms) target.setUTCDate(target.getUTCDate() + 1);
  return target.getTime();
}

/**
 * Returns `count` epoch-ms timestamps, strictly ascending, ready to write into
 * `approvals.auto_send_target_at` (oldest selected → soonest send).
 */
export function computeAutoSendSchedule(opts: AutoSendScheduleOpts): number[] {
  const rng = opts.rng ?? Math.random;
  const minGap = Math.max(0, opts.minGapSec);
  const maxGap = Math.max(minGap, opts.maxGapSec);
  const hasQuiet =
    typeof opts.quietStartHourUtc === "number" &&
    typeof opts.quietEndHourUtc === "number";

  const out: number[] = [];
  let cursor = opts.startAtMs;
  for (let i = 0; i < opts.count; i++) {
    const gapSec = minGap + rng() * (maxGap - minGap);
    cursor += Math.round(gapSec * 1000);
    if (
      hasQuiet &&
      inQuietWindow(cursor, opts.quietStartHourUtc!, opts.quietEndHourUtc!)
    ) {
      cursor = pushPastQuiet(cursor, opts.quietEndHourUtc!);
    }
    out.push(cursor);
  }
  return out;
}

/** Remaining daily auto-send budget for an instance. Pure: never negative. */
export function autoSendRemainingBudget(opts: { cap: number; sentLast24h: number; pendingScheduled: number }): number {
  const cap = Math.max(0, Math.floor(opts.cap));
  const used = Math.max(0, opts.sentLast24h) + Math.max(0, opts.pendingScheduled);
  return Math.max(0, cap - used);
}
