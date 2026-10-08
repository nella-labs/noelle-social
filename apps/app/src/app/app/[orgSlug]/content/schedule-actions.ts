"use server";

import { revalidatePath } from "next/cache";
import { noelleFetch } from "@/lib/api";
import { getOrgBySlug } from "@/lib/queries";
import { listScheduleSlotsForOrg } from "@/lib/schedule-queries";
import { SlotMutationOutSchema, type SlotMutationOut } from "@noelle/contracts";
import { toCalendarSlot, type CalendarSlot } from "@/components/posts/schedule-slots";

const SkipReceiptSchema = SlotMutationOutSchema.pick({ id: true, status: true });

/**
 * Load slots for an arbitrary date window (client calls this when the calendar
 * navigates to a month outside the initial server-rendered window — so the month
 * view populates for posts scheduled far ahead). Read-only, org-scoped.
 */
export async function loadScheduleSlotsAction(
  orgSlug: string,
  platform: string,
  from: string,
  to: string,
): Promise<CalendarSlot[]> {
  const org = await getOrgBySlug(orgSlug);
  if (!org) throw new Error("Schedule unavailable");
  const p = platform === "all" ? null : platform;
  const rows = await listScheduleSlotsForOrg(org.id, { from, to }, p);
  return rows.map(toCalendarSlot);
}

/**
 * Server actions for the Schedule calendar. The client calendar imports these
 * directly. Each delegates the write to api-vm (which enforces org membership +
 * the auto-publish role gate) and revalidates the content page.
 */

export async function rescheduleSlotAction(orgSlug: string, slotId: string, slotAt: string): Promise<SlotMutationOut> {
  const receipt = SlotMutationOutSchema.parse(await noelleFetch<unknown>(`/api/content/slots/${slotId}`, {
    method: "PATCH",
    body: { slotAt },
  }));
  if (receipt.id.toLowerCase() !== slotId.toLowerCase()) throw new Error("Schedule change unconfirmed");
  revalidatePath(`/app/${orgSlug}/content`);
  return receipt;
}

export async function skipSlotAction(orgSlug: string, slotId: string): Promise<Pick<SlotMutationOut, "id" | "status">> {
  const receipt = SkipReceiptSchema.parse(await noelleFetch<unknown>(`/api/content/slots/${slotId}`, {
    method: "DELETE",
  }));
  if (receipt.id.toLowerCase() !== slotId.toLowerCase() || receipt.status !== "skipped") throw new Error("Schedule change unconfirmed");
  revalidatePath(`/app/${orgSlug}/content`);
  return receipt;
}

export async function createComposeJobAction(
  orgSlug: string,
  input: {
    instanceId: string;
    platform: string;
    perDay: number;
    days: number;
    startDate: string;
    topic?: string;
    autoPublish?: boolean;
  },
): Promise<{ job_id: string; items_total: number }> {
  const out = await noelleFetch<{ job_id: string; items_total: number }>(`/api/content/slots/bulk`, {
    method: "POST",
    body: input,
  });
  revalidatePath(`/app/${orgSlug}/content`);
  return out;
}

export async function createSlotAction(
  orgSlug: string,
  input: { instanceId: string; platform: string; slotAt: string; draftId?: string; autoPublish?: boolean },
): Promise<void> {
  await noelleFetch<SlotMutationOut>(`/api/content/slots`, { method: "POST", body: input });
  revalidatePath(`/app/${orgSlug}/content`);
}
