/**
 * Pure, UTC-stable date helpers for the Schedule calendar. Every function takes
 * and returns `YYYY-MM-DD` strings so the same math runs identically on the
 * server and the client — no `new Date()` at render time, no timezone drift, no
 * hydration mismatch. Mirrors the `addDays` idiom already used in
 * ContentWeekPlanner; this just adds month/week grid math on top.
 */

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

export const WEEKDAY_SHORT = ["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"] as const;

function utc(ymd: string): Date {
  return new Date(`${ymd}T00:00:00Z`);
}

function fmt(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function addDays(ymd: string, n: number): string {
  const d = utc(ymd);
  d.setUTCDate(d.getUTCDate() + n);
  return fmt(d);
}

/** Monday-indexed weekday: Mon=0 … Sun=6. */
function mondayIndex(ymd: string): number {
  return (utc(ymd).getUTCDay() + 6) % 7;
}

export function startOfWeekMonday(ymd: string): string {
  return addDays(ymd, -mondayIndex(ymd));
}

/** The seven ISO days (Mon…Sun) of the week containing `ymd`. */
export function weekDays(ymd: string): string[] {
  const monday = startOfWeekMonday(ymd);
  return Array.from({ length: 7 }, (_, i) => addDays(monday, i));
}

/** Full weeks (Mon-start) covering `ymd`'s month, padded with adjacent days. */
export function monthMatrix(ymd: string): string[][] {
  const d = utc(ymd);
  const firstOfMonth = fmt(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)));
  const lastOfMonth = fmt(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)));
  const weeks: string[][] = [];
  let cursor = startOfWeekMonday(firstOfMonth);
  for (;;) {
    const row = Array.from({ length: 7 }, (_, i) => addDays(cursor, i));
    weeks.push(row);
    const tail = row[6];
    if (tail && tail >= lastOfMonth) break;
    cursor = addDays(cursor, 7);
  }
  return weeks;
}

export function isSameMonth(ymd: string, anchor: string): boolean {
  return ymd.slice(0, 7) === anchor.slice(0, 7);
}

/** Shift by whole months, clamping the day to the target month's length. */
export function addMonths(ymd: string, n: number): string {
  const d = utc(ymd);
  const target = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1));
  const ty = target.getUTCFullYear();
  const tm = target.getUTCMonth();
  const daysInTarget = new Date(Date.UTC(ty, tm + 1, 0)).getUTCDate();
  const clampedDay = Math.min(d.getUTCDate(), daysInTarget);
  return fmt(new Date(Date.UTC(ty, tm, clampedDay)));
}

export function monthLabel(ymd: string): string {
  const d = utc(ymd);
  return `${MONTHS[d.getUTCMonth()] ?? ""} ${d.getUTCFullYear()}`;
}

export function dayOfMonth(ymd: string): number {
  return utc(ymd).getUTCDate();
}
