/**
 * Pure slot-time generator for the Compose bulk action. Given perDay / days /
 * UTC posting windows, returns ISO-8601 slot times spread across each day —
 * using the configured windows when perDay fits, else fanning evenly across the
 * window span. Deterministic (no randomness) so a plan is reproducible.
 */

function addDaysUTC(ymd: string, n: number): string {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function iso(ymd: string, hour: number, minute: number): string {
  return `${ymd}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00Z`;
}

function dayTimes(perDay: number, windows: number[]): { h: number; m: number }[] {
  const w = windows.length > 0 ? [...windows].sort((a, b) => a - b) : [9, 13, 17, 21];
  if (perDay <= w.length) {
    return w.slice(0, perDay).map((h) => ({ h, m: 0 }));
  }
  const minH = w[0]!;
  const maxH = w[w.length - 1]!;
  const spanMin = (maxH - minH) * 60;
  const out: { h: number; m: number }[] = [];
  for (let i = 0; i < perDay; i++) {
    const totalMin = minH * 60 + Math.round((spanMin * i) / (perDay - 1));
    out.push({ h: Math.floor(totalMin / 60), m: totalMin % 60 });
  }
  return out;
}

export function computeComposeSlots(args: {
  startDate: string;
  days: number;
  perDay: number;
  windowsUtc: number[];
}): string[] {
  const out: string[] = [];
  for (let d = 0; d < args.days; d++) {
    const ymd = addDaysUTC(args.startDate, d);
    for (const t of dayTimes(args.perDay, args.windowsUtc)) {
      out.push(iso(ymd, t.h, t.m));
    }
  }
  return out;
}
