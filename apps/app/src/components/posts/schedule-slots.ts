/** Read row and client view for the Schedule calendar. */
export interface ScheduleSlotRow {
  id: string;
  agent_instance_id: string;
  platform: string;
  slot_at: string;
  status: string;
  idea_id: string | null;
  draft_id: string | null;
  auto_publish: boolean;
  window_source: string;
  batch_id: string | null;
  target_kind: string;
  posted_url: string | null;
  published_at: string | null;
  preview: string | null;
  hook: string | null;
}

export interface CalendarSlot {
  id: string;
  /** ISO-8601 UTC. */
  slotAt: string;
  platform: string;
  status: string;
  autoPublish: boolean;
  preview: string | null;
  hook: string | null;
}

export interface ScheduleWindow { from: string; to: string }

export function toCalendarSlot(row: ScheduleSlotRow): CalendarSlot {
  return { id: row.id, slotAt: row.slot_at, platform: row.platform, status: row.status,
    autoPublish: row.auto_publish, preview: row.preview, hook: row.hook };
}

/** Known publishing states and an outstanding mutation disable local controls. */
export function canMutateCalendarSlot(slot: CalendarSlot, busy: boolean): boolean {
  return !busy && slot.status !== "published" && slot.status !== "publishing";
}
