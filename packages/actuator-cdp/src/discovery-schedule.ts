/** Local browser schedule for Discover + Reply; each extension has isolated storage. */
export const DISCOVERY_SCHEDULE_KEY = "noelle.discoverySchedule.v1";

export type DiscoverySchedule = {
  enabled: boolean;
  start: string;
  end: string;
};

export const DEFAULT_DISCOVERY_SCHEDULE: DiscoverySchedule = {
  enabled: false,
  start: "01:00",
  end: "09:00",
};

const timePattern = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

export function parseDiscoverySchedule(value: unknown): DiscoverySchedule {
  if (!value || typeof value !== "object") return { ...DEFAULT_DISCOVERY_SCHEDULE };
  const candidate = value as Partial<DiscoverySchedule>;
  if (typeof candidate.enabled !== "boolean"
    || typeof candidate.start !== "string"
    || typeof candidate.end !== "string"
    || !timePattern.test(candidate.start)
    || !timePattern.test(candidate.end)
    || candidate.start === candidate.end) {
    return { ...DEFAULT_DISCOVERY_SCHEDULE };
  }
  return { enabled: candidate.enabled, start: candidate.start, end: candidate.end };
}

/** Start-inclusive, end-exclusive, in the browser's local timezone. */
export function isDiscoveryQuietTime(atMs: number, schedule: DiscoverySchedule): boolean {
  if (!schedule.enabled) return false;
  const date = new Date(atMs);
  const minute = date.getHours() * 60 + date.getMinutes();
  const [startHour, startMinute] = schedule.start.split(":").map(Number);
  const [endHour, endMinute] = schedule.end.split(":").map(Number);
  const start = startHour! * 60 + startMinute!;
  const end = endHour! * 60 + endMinute!;
  return start < end
    ? minute >= start && minute < end
    : minute >= start || minute < end;
}
