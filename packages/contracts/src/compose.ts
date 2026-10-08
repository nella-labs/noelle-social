import { z } from "zod";
import { UuidSchema } from "./common.js";
import { SlotPlatformSchema } from "./content-schedule.js";

/**
 * Compose action engine bodies. v1 ships the headline action: bulk-draft +
 * schedule ("N posts/day for M weeks"). The handler does ZERO LLM work — it
 * fans the plan out into approved post_ideas + empty scheduled slots in one
 * transaction; the existing drafter then drafts them, chunked, OOM-safe.
 */

/** Hard ceiling so a runaway "200 posts/day for a year" can never expand in-process. */
export const COMPOSE_MAX_ITEMS = 200;

export const ComposeBulkInSchema = z.object({
  instanceId: UuidSchema,
  platform: SlotPlatformSchema,
  /** Posts per day. */
  perDay: z.number().int().min(1).max(50),
  /** Number of days to schedule. */
  days: z.number().int().min(1).max(90),
  /** First day (YYYY-MM-DD, UTC). */
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  /** Optional steer for the drafter (a theme / angle for the batch). */
  topic: z.string().max(2000).optional(),
  /** Vega only — the DB trigger rejects it for draft-only agents. */
  autoPublish: z.boolean().default(false),
});
export type ComposeBulkIn = z.infer<typeof ComposeBulkInSchema>;

export const ComposeJobOutSchema = z.object({
  job_id: UuidSchema,
  items_total: z.number().int(),
});
export type ComposeJobOut = z.infer<typeof ComposeJobOutSchema>;
