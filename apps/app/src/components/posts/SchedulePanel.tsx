import { getOrgBySlug } from "@/lib/queries";
import { listScheduleSlotsForOrg } from "@/lib/schedule-queries";
import { CONFIG_BY_PLATFORM, type WorkspaceLaneView } from "@/lib/agent-content-config";
import { ScheduleCalendar } from "./ScheduleCalendar";
import { toCalendarSlot } from "./schedule-slots";
import { addDays, startOfWeekMonday } from "./schedule-dates";

/**
 * Server wrapper for the Schedule section: resolves the org, loads the slot
 * window (last week → +2 weeks) for the active lane, and hands it to the client
 * ScheduleCalendar. Vega's slots can carry auto-publish; the draft-only lanes
 * show the same calendar but their slots only surface for copy-out.
 */
export async function SchedulePanel({ lane, orgSlug }: { lane: WorkspaceLaneView; orgSlug: string }) {
  const org = await getOrgBySlug(orgSlug);
  if (!org) return null;

  // Server-computed anchor (hydration-safe — handed to the client as a string).
  const today = new Date().toISOString().slice(0, 10);
  const week0 = startOfWeekMonday(today);
  const from = `${addDays(week0, -7)}T00:00:00Z`;
  const to = `${addDays(week0, 21)}T00:00:00Z`;

  const platform = lane.platform === "all" ? null : lane.platform;
  const rows = await listScheduleSlotsForOrg(org.id, { from, to }, platform);

  const cfg = lane.platform !== "all" ? CONFIG_BY_PLATFORM[lane.platform] : null;
  const canAutoPost = cfg?.capabilities.canAutoPost ?? false;

  const slots = rows.map(toCalendarSlot);

  const agent = lane.identity.agent;
  const emptyHint = canAutoPost
    ? `Nothing scheduled this week yet. Plan posts in Compose — ${agent} drafts them and auto-publishes at your strongest windows (you stay under the daily cap).`
    : `Nothing scheduled this week yet. Plan posts in Compose — ${agent} drafts them for your approval at each slot (it never posts on its own).`;

  return (
    <ScheduleCalendar
      orgSlug={orgSlug}
      today={today}
      initialWindow={{ from, to }}
      slots={slots}
      platform={lane.platform}
      laneColor={lane.identity.color}
      canAutoPost={canAutoPost}
      emptyHint={emptyHint}
    />
  );
}
