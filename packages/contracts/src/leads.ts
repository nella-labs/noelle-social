import { z } from "zod";
import { AngleSchema, TimestampSchema, UuidSchema } from "./common.js";

// GET /api/leads/:lead_id
// Returns a single lead payload for the dashboard drill-in view. Distinct
// from the @noelle/types `Lead` row alias: this is the wire shape, the row
// alias is the raw Supabase Row type.

export const LeadPayloadSchema = z.object({
  id: UuidSchema,
  /**
   * External identifier for the lead (e.g. an X post id or other upstream
   * source's primary key). Mirrors noelle.leads.external_id.
   */
  external_id: z.string(),
  post_id: z.string(),
  author_handle: z.string(),
  author_id: z.string(),
  author_followers: z.number().int().nullable(),
  post_text: z.string(),
  posted_at: TimestampSchema,
  status: z.string(),
  matched_trigger_id: UuidSchema.nullable(),
  created_at: TimestampSchema,
});
export type LeadPayload = z.infer<typeof LeadPayloadSchema>;

// GET /api/drafts?lead_id=...  → all drafts for one lead.

export const DraftPayloadSchema = z.object({
  id: UuidSchema,
  lead_id: UuidSchema,
  angle: AngleSchema,
  body: z.string(),
  char_count: z.number().int().nullable(),
  selected: z.boolean(),
  edited_body: z.string().nullable(),
  sent_at: TimestampSchema.nullable(),
  created_at: TimestampSchema,
});
export type DraftPayload = z.infer<typeof DraftPayloadSchema>;
