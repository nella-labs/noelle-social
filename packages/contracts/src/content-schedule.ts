import { z } from "zod";
import { UuidSchema, TimestampSchema } from "./common.js";

export const CONTENT_PUBLISH_UNCERTAIN_ERROR =
  "publish outcome uncertain; reconcile the X account before retrying";
export const CONTENT_PUBLISH_DUPLICATE_ERROR =
  "duplicate content rejected without a receipt; reconcile the X account before retrying";

/**
 * HTTP bodies for the Content Schedule calendar (api-vm `content-schedule`
 * route). Reads happen directly in the app (schedule-queries.ts); these schemas
 * cover the WRITES: place a slot, drag-reschedule a slot, skip a slot.
 */

export const SlotStatusSchema = z.enum([
  "empty",
  "drafting",
  "drafted",
  "ready",
  "publishing",
  "published",
  "skipped",
  "failed",
]);
export type SlotStatus = z.infer<typeof SlotStatusSchema>;

export const SlotPlatformSchema = z.enum(["x", "linkedin", "reddit", "video"]);
export type SlotPlatform = z.infer<typeof SlotPlatformSchema>;

/** Place a slot on the calendar (manual scheduling, optionally binding a draft). */
export const CreateSlotInSchema = z.object({
  instanceId: UuidSchema,
  platform: SlotPlatformSchema,
  slotAt: z.string().datetime({ offset: true }),
  draftId: UuidSchema.optional(),
  /** Only honoured for Vega; the DB trigger rejects it for draft-only agents. */
  autoPublish: z.boolean().default(false),
});
export type CreateSlotIn = z.infer<typeof CreateSlotInSchema>;

/** Drag-reschedule: move a slot to a new time. */
export const RescheduleSlotInSchema = z.object({
  slotAt: z.string().datetime({ offset: true }),
});
export type RescheduleSlotIn = z.infer<typeof RescheduleSlotInSchema>;

export const SlotMutationOutSchema = z.object({
  id: UuidSchema,
  slot_at: TimestampSchema,
  status: SlotStatusSchema,
  auto_publish: z.boolean(),
});
export type SlotMutationOut = z.infer<typeof SlotMutationOutSchema>;
