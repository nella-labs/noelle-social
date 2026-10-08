import { z } from "zod";
import { BucketSchema, UuidSchema } from "./common.js";
import { OutboundPlatformSchema } from "./outbound.js";

// GET /api/outbound/cap-status   (drafter pre-call check). Drafter polls
// before paid calls so it can short-circuit on a full bucket.

export const PlatformCapStatusSchema = z.object({
  active: z.number().int().nonnegative(),
  cap: z.number().int().nonnegative(),
  full: z.boolean(),
});
export type PlatformCapStatus = z.infer<typeof PlatformCapStatusSchema>;

export const CapStatusSchema = z.record(
  OutboundPlatformSchema,
  PlatformCapStatusSchema
);
export type CapStatus = z.infer<typeof CapStatusSchema>;

// GET /api/cap-status?org_id=...   (Noelle dashboard view).
// Layered caps per D27: bucket + org + per-instance.

export const BudgetLayerSchema = z.enum(["bucket", "org", "instance"]);
export type BudgetLayer = z.infer<typeof BudgetLayerSchema>;

export const OrgBucketSpendSchema = z.object({
  bucket: BucketSchema,
  cents_spent: z.number().int().nonnegative(),
  cents_cap: z.number().int().nonnegative().nullable(),
  layer: BudgetLayerSchema,
});
export type OrgBucketSpend = z.infer<typeof OrgBucketSpendSchema>;

export const OrgCapStatusSchema = z.object({
  org_id: UuidSchema,
  month: z.string().regex(/^\d{4}-\d{2}$/),
  spend: z.array(OrgBucketSpendSchema),
  any_over: z.boolean(),
});
export type OrgCapStatus = z.infer<typeof OrgCapStatusSchema>;
