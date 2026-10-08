import { z } from "zod";
import {
  ApprovalStatusSchema,
  TimestampSchema,
  UuidSchema,
} from "./common.js";

// POST /api/drafts/:id/send   (Supabase JWT auth; called from apps/app Server Action)
// :id is the noelle.approvals.id (UUID). Body carries the actual text being
// sent (the operator may have edited the draft in the UI before clicking Send).

export const DraftSendInSchema = z.object({
  body: z.string().min(1),
  edited: z.boolean().default(false),
});
export type DraftSendIn = z.infer<typeof DraftSendInSchema>;

export const DraftSendOutSchema = z.object({
  approval_id: UuidSchema,
  draft_id: UuidSchema,
  status: ApprovalStatusSchema,
  sent_at: TimestampSchema,
  // Populated when /send posted to X synchronously (the normal path on
  // noelle-vm-0). Omitted on the legacy async path where the send worker
  // posts later — the dashboard polls the approval row in that case.
  sent_external_id: z.string().optional(),
  sent_url: z.string().url().optional(),
  sibling_skipped: z.number().int().nonnegative().optional(),
  // Whether the agent also liked the replied-to tweet (best-effort; a like
  // failure never fails the send).
  liked: z.boolean().optional(),
});
export type DraftSendOut = z.infer<typeof DraftSendOutSchema>;

// POST /api/drafts/:id/skip  — the operator marks a draft as not-going-to-send.

export const DraftSkipInSchema = z.object({
  reason: z.string().max(500).optional(),
});
export type DraftSkipIn = z.infer<typeof DraftSkipInSchema>;

export const DraftSkipOutSchema = z.object({
  approval_id: UuidSchema,
  status: ApprovalStatusSchema,
});
export type DraftSkipOut = z.infer<typeof DraftSkipOutSchema>;

// POST /api/drafts/bulk-skip — soft-skip a batch of picked approvals in one
// call (the inbox "Skip selected" action). Flips each pending approval to
// 'skipped'; non-pending / other-org ids are silently ignored.
export const BulkSkipInSchema = z.object({
  org_id: UuidSchema,
  approval_ids: z.array(UuidSchema).min(1).max(200),
  reason: z.string().max(500).optional(),
});
export type BulkSkipIn = z.infer<typeof BulkSkipInSchema>;

export const BulkSkipOutSchema = z.object({
  /** How many rows actually flipped (already-skipped / non-pending ignored). */
  skipped_count: z.number().int().nonnegative(),
});
export type BulkSkipOut = z.infer<typeof BulkSkipOutSchema>;

// POST /api/drafts/:id/unskip — reverse a soft-skip: 'skipped' -> 'pending',
// clearing the decision stamp so the row returns to the actionable queue.
export const DraftUnskipOutSchema = z.object({
  approval_id: UuidSchema,
  status: ApprovalStatusSchema,
});
export type DraftUnskipOut = z.infer<typeof DraftUnskipOutSchema>;

// POST /api/drafts/:id/park — "Wait for reply": park a DM (status -> 'deferred')
// so it leaves the pending inbox and shows on the person's Contacts page with a
// "Send DM" button. No body.

export const DraftParkInSchema = z.object({});
export type DraftParkIn = z.infer<typeof DraftParkInSchema>;

export const DraftParkOutSchema = z.object({
  approval_id: UuidSchema,
  status: ApprovalStatusSchema,
});
export type DraftParkOut = z.infer<typeof DraftParkOutSchema>;

// GET /api/x/whoami — which X account the org's cookies post as.
export const XWhoamiOutSchema = z.object({
  connected: z.boolean(),
  handle: z.string().optional(),
  id: z.string().optional(),
});
export type XWhoamiOut = z.infer<typeof XWhoamiOutSchema>;

// POST /api/drafts/schedule-auto-send — queue a batch of picked reply approvals
// for staggered, jittered auto-send (the send worker fires them, rate-braked).
export const ScheduleAutoSendInSchema = z.object({
  org_id: UuidSchema,
  /** The chosen reply approval per lead (one each). DMs are ignored. */
  approval_ids: z.array(UuidSchema).min(1).max(200),
});
export type ScheduleAutoSendIn = z.infer<typeof ScheduleAutoSendInSchema>;

export const ScheduleAutoSendOutSchema = z.object({
  scheduled: z.array(
    z.object({ approval_id: UuidSchema, target_at: TimestampSchema }),
  ),
  /** How many were queued (requested ids that aren't pending replies in this org are skipped). */
  count: z.number().int().nonnegative(),
  /** How many eligible rows were left unscheduled by budget, review gates, or a chosen sibling angle. */
  withheld: z.number().int().nonnegative().default(0),
});
export type ScheduleAutoSendOut = z.infer<typeof ScheduleAutoSendOutSchema>;

// POST /api/drafts/:id/mark-sent — manual send. The reviewer already posted
// the reply on X by hand (the Speedrun copy → paste → mark-sent flow, or
// because the lead has no valid in_reply_to anchor so the synchronous /send
// can't post). This records the approval as 'sent' WITHOUT api.trynoelle.com
// re-posting to X, and skips the lead's other angles like /send does.
//
// The human already chose+sent the text on X, so there's nothing for us to post.
// The server writes a non-null `sent_external_id` so the send worker
// (status='sent' AND sent_external_id IS NULL) never re-posts it.
//
// Optional `tweet_url`: when the reviewer pastes the link to the reply they
// posted on X, the server extracts the tweet id from it and stores the REAL id
// (+ the url) instead of the `manual:` sentinel, so the dashboard can show a
// live "view reply" link. Omitted → the sentinel, no link (the prior behaviour).

export const DraftMarkSentInSchema = z.object({
  tweet_url: z.string().url().optional(),
  sent_via: z.enum(["manual", "extension"]).optional(),
});
export type DraftMarkSentIn = z.infer<typeof DraftMarkSentInSchema>;

export const DraftMarkSentOutSchema = z.object({
  approval_id: UuidSchema,
  draft_id: UuidSchema,
  status: ApprovalStatusSchema,
  sent_at: TimestampSchema,
  // "manual" (reviewer clicked Mark Sent) or "extension" (browser extension
  // reported the send). Distinguishes this from an X-posted send so the
  // dashboard renders "marked sent" instead of a "view on X" link.
  sent_via: z.enum(["manual", "extension"]),
  // Present when the reviewer pasted a tweet URL we could parse — the live link
  // to their hand-posted reply.
  sent_url: z.string().url().nullable().optional(),
  sibling_skipped: z.number().int().nonnegative().optional(),
});
export type DraftMarkSentOut = z.infer<typeof DraftMarkSentOutSchema>;

// POST /api/drafts/:id/unmark-sent — undo a MANUAL mark-sent (the transient
// "Undo" affordance). Reverses /mark-sent: the approval goes 'sent' → 'pending',
// the draft is un-locked (sent_external_id/posted_at cleared, sent_via/sent_url
// stripped) so it re-enters the queue, and the rows the same mark-sent stamped
// (sibling reply angles skipped 'sibling-angle-sent', and any auto-deferred DM)
// are restored to 'pending'. Only a MANUAL send is reversible — a draft posted
// to a real platform (a non-`manual:` sent_external_id) returns 409, since we
// can't un-post it. No request body.
export const DraftUnmarkSentOutSchema = z.object({
  approval_id: UuidSchema,
  draft_id: UuidSchema,
  status: ApprovalStatusSchema,
  // How many sibling/DM approvals were restored to 'pending' alongside the target.
  restored: z.number().int().nonnegative(),
});
export type DraftUnmarkSentOut = z.infer<typeof DraftUnmarkSentOutSchema>;
