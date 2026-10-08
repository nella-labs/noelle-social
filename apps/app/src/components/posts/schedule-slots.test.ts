import { expect, test } from "vitest";
import { canMutateCalendarSlot, toCalendarSlot, type ScheduleSlotRow } from "./schedule-slots";

const row: ScheduleSlotRow = { id: "slot", agent_instance_id: "instance", platform: "linkedin",
  slot_at: "2026-10-07T12:00:00Z", status: "ready", idea_id: null, draft_id: null,
  auto_publish: false, window_source: "manual", batch_id: null, target_kind: "post",
  posted_url: null, published_at: null, preview: null, hook: "Current hook" };

test("both server producers preserve null preview, date, lane and manual publishing state", () => {
  expect(toCalendarSlot(row)).toEqual({ id: "slot", slotAt: row.slot_at, platform: "linkedin", status: "ready",
    autoPublish: false, preview: null, hook: "Current hook" });
});
test.each([
  ["ready", false, true], ["ready", true, false], ["publishing", false, false], ["published", false, false],
] as const)("%s with busy=%s has shared control eligibility %s", (status, busy, expected) => {
  expect(canMutateCalendarSlot({ ...toCalendarSlot(row), status }, busy)).toBe(expected);
});
