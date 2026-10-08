"use server";

/**
 * Server Actions for the Approvals inbox. Driven by <DraftReview> on the
 * detail page. Both endpoints POST to api.trynoelle.com (the Hono service)
 * via noelleFetch; on success we revalidate the inbox + detail routes so the
 * next render reflects the new status.
 *
 * Wire shapes per @noelle/contracts (drafts.ts):
 *   POST /api/drafts/:approvalId/send  body { body, edited }
 *     → { approval_id, draft_id, status, sent_at, sent_url?, sent_external_id?, sibling_skipped? }
 *   POST /api/drafts/:approvalId/skip  body { reason? }
 *     → { approval_id, status }
 *
 * The `:id` path param is the noelle.approvals.id (UUID), NOT the underlying
 * draft id — the Hono router resolves the draft via the approval. As of the
 * synchronous-send refactor, the send route posts to X inline and surfaces
 * the live tweet URL back to this action so the UI can render
 * "Sent ✓ view on X". The send worker stays as a backstop for retries.
 *
 * Tenant-guard note (Phase 2): no `assertOrgMember` call here — these actions
 * never touch `noelle.*` directly. The api.trynoelle.com Hono routes do the
 * org-membership check via `isOrgMember(auth.userId, approval.org_id)`
 * (apps/api-vm/src/routes/drafts.ts) before flipping any row.
 */

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { PatternRefineInputSchema } from "@noelle/contracts";
import { noelleFetch, NoelleApiError } from "@/lib/api";
import { withRateLimit } from "@/lib/with-rate-limit";
import {
  DraftSendInSchema,
  DraftSendOutSchema,
  DraftSkipInSchema,
  DraftSkipOutSchema,
  DraftParkOutSchema,
  ScheduleAutoSendOutSchema,
  DraftMarkSentOutSchema,
  DraftUnmarkSentOutSchema,
  BulkSkipOutSchema,
  DraftUnskipOutSchema,
  type DraftSendIn,
  type DraftSendOut,
  type DraftSkipIn,
  type DraftSkipOut,
  type DraftParkOut,
  type ScheduleAutoSendOut,
  type DraftMarkSentOut,
  type DraftUnmarkSentOut,
  type BulkSkipOut,
  type DraftUnskipOut,
} from "@/lib/contracts";

const SendInput = z.object({
  orgSlug: z.string().min(1),
  approvalId: z.string().uuid(),
  /** The original body text — used to detect whether the user actually edited it. */
  originalBody: z.string(),
  /** What the user is sending. May or may not equal originalBody. */
  body: z.string().min(1).max(4000),
});

export type SendDraftInput = z.infer<typeof SendInput>;

export type SendDraftResult =
  | {
      ok: true;
      sentAt: string;
      draftId: string;
      /** Public X URL the reply was posted to, when api-vm posted synchronously. */
      sentUrl?: string;
      /** X tweet id of the live reply, when available. */
      sentExternalId?: string;
    }
  | {
      ok: false;
      error: {
        code: string;
        message: string;
        status: number;
        retry_after_ms?: number;
      };
    };

// Cost-2 + 60 cap = 30 effective approvals per minute, refilling at 1/sec.
// The send path is the most expensive flow (DB write + Cloud SQL approval
// flip + X post downstream), so we charge it 2 tokens vs. 1 for typical ops.
export const sendDraft = withRateLimit(
  "approvals.send",
  { capacity: 60, refillPerSecond: 1, cost: 2 },
  async (input: SendDraftInput): Promise<SendDraftResult> => {
    const parsed = SendInput.parse(input);
    const wire: DraftSendIn = {
      body: parsed.body,
      edited: parsed.body !== parsed.originalBody,
    };
    DraftSendInSchema.parse(wire); // pre-flight validation

    try {
      const res = await noelleFetch<DraftSendOut>(
        `/api/drafts/${encodeURIComponent(parsed.approvalId)}/send`,
        { method: "POST", body: wire },
      );
      DraftSendOutSchema.parse(res);
      revalidatePath(`/app/${parsed.orgSlug}/approvals`);
      revalidatePath(`/app/${parsed.orgSlug}/approvals/${parsed.approvalId}`);
      return {
        ok: true,
        sentAt: res.sent_at,
        draftId: res.draft_id,
        sentUrl: res.sent_url,
        sentExternalId: res.sent_external_id,
      };
    } catch (e) {
      if (e instanceof NoelleApiError) {
        return {
          ok: false,
          error: {
            code: e.code,
            message: e.message,
            status: e.status,
            retry_after_ms: e.retryAfterMs,
          },
        };
      }
      throw e;
    }
  },
);

const SaveEditInput = z.object({
  orgSlug: z.string().min(1),
  approvalId: z.string().uuid(),
  /** The edited draft body to persist as the learning signal. */
  body: z.string().min(1).max(4000),
});

export type SaveDraftEditInput = z.infer<typeof SaveEditInput>;

export type SaveDraftEditResult =
  | { ok: true; draftId: string }
  | {
      ok: false;
      error: {
        code: string;
        message: string;
        status: number;
        retry_after_ms?: number;
      };
    };

/**
 * Persist an operator's edit to a draft body WITHOUT sending or marking it
 * sent. The learning-signal write path for the LinkedIn intern (Lyra), which is
 * draft-only: she never posts, so there's no /send to fold the edited body into.
 * The LinkedIn panel calls this before "Mark sent" whenever the operator edited
 * the text, so payload.edited_body is captured even though nothing is dispatched
 * by us. POSTs to api.trynoelle.com `/api/drafts/:id/save-edit` (JWT, same as
 * the sibling routes). Shares the approvals.send rate bucket.
 */
export const saveDraftEdit = withRateLimit(
  "approvals.send",
  { capacity: 60, refillPerSecond: 1, cost: 2 },
  async (input: SaveDraftEditInput): Promise<SaveDraftEditResult> => {
    const parsed = SaveEditInput.parse(input);
    try {
      const res = await noelleFetch<{ draft_id: string; saved: boolean }>(
        `/api/drafts/${encodeURIComponent(parsed.approvalId)}/save-edit`,
        { method: "POST", body: { body: parsed.body } },
      );
      revalidatePath(`/app/${parsed.orgSlug}/approvals`);
      revalidatePath(`/app/${parsed.orgSlug}/approvals/${parsed.approvalId}`);
      return { ok: true, draftId: res.draft_id };
    } catch (e) {
      if (e instanceof NoelleApiError) {
        return {
          ok: false,
          error: {
            code: e.code,
            message: e.message,
            status: e.status,
            retry_after_ms: e.retryAfterMs,
          },
        };
      }
      throw e;
    }
  },
);

const SkipInput = z.object({
  orgSlug: z.string().min(1),
  approvalId: z.string().uuid(),
  /** Free-form reason — N2's contract takes a single string, not an enum. */
  reason: z.string().max(500).optional(),
});

export type SkipDraftInput = z.infer<typeof SkipInput>;

export type SkipDraftResult =
  | { ok: true; status: import("@noelle/contracts").ApprovalStatus }
  | {
      ok: false;
      error: {
        code: string;
        message: string;
        status: number;
        retry_after_ms?: number;
      };
    };

// Skip shares the 'approvals.send' bucket so the limit is "approvals work"
// as a whole, not send vs skip separately. Same cap (60), cost 2 → 30/min.
export const skipDraft = withRateLimit(
  "approvals.send",
  { capacity: 60, refillPerSecond: 1, cost: 2 },
  async (input: SkipDraftInput): Promise<SkipDraftResult> => {
    const parsed = SkipInput.parse(input);
    const wire: DraftSkipIn = { reason: parsed.reason };
    DraftSkipInSchema.parse(wire);

    try {
      const res = await noelleFetch<DraftSkipOut>(
        `/api/drafts/${encodeURIComponent(parsed.approvalId)}/skip`,
        { method: "POST", body: wire },
      );
      DraftSkipOutSchema.parse(res);
      revalidatePath(`/app/${parsed.orgSlug}/approvals`);
      revalidatePath(`/app/${parsed.orgSlug}/approvals/${parsed.approvalId}`);
      return { ok: true, status: res.status };
    } catch (e) {
      if (e instanceof NoelleApiError) {
        return {
          ok: false,
          error: {
            code: e.code,
            message: e.message,
            status: e.status,
            retry_after_ms: e.retryAfterMs,
          },
        };
      }
      throw e;
    }
  },
);

const BulkSkipInput = z.object({
  orgSlug: z.string().min(1),
  orgId: z.string().uuid(),
  approvalIds: z.array(z.string().uuid()).min(1).max(200),
  reason: z.string().max(500).optional(),
});
export type BulkSkipActionResult =
  | { ok: true; count: number }
  | { ok: false; error: { code: string; message: string; status: number } };

/**
 * Soft-skip a batch of picked approvals — the inbox "Skip selected" action.
 * POSTs to /api/drafts/bulk-skip which flips the pending ones to 'skipped'.
 * Shares the approvals.send rate bucket (same "approvals work" cap).
 */
export const bulkSkipDrafts = withRateLimit(
  "approvals.send",
  { capacity: 60, refillPerSecond: 1, cost: 2 },
  async (input: z.infer<typeof BulkSkipInput>): Promise<BulkSkipActionResult> => {
    const parsed = BulkSkipInput.parse(input);
    try {
      const res = await noelleFetch<BulkSkipOut>(`/api/drafts/bulk-skip`, {
        method: "POST",
        body: { org_id: parsed.orgId, approval_ids: parsed.approvalIds, reason: parsed.reason },
      });
      BulkSkipOutSchema.parse(res);
      revalidatePath(`/app/${parsed.orgSlug}/approvals`);
      return { ok: true, count: res.skipped_count };
    } catch (e) {
      if (e instanceof NoelleApiError) {
        return { ok: false, error: { code: e.code, message: e.message, status: e.status } };
      }
      throw e;
    }
  },
);

const UnskipInput = z.object({
  orgSlug: z.string().min(1),
  approvalId: z.string().uuid(),
});
export type UnskipDraftResult =
  | { ok: true; status: import("@noelle/contracts").ApprovalStatus }
  | { ok: false; error: { code: string; message: string; status: number; retry_after_ms?: number } };

/**
 * Reverse a soft-skip ('skipped' -> 'pending') so an accidentally-skipped row
 * returns to the queue. Shares the approvals.send bucket.
 */
export const unskipDraft = withRateLimit(
  "approvals.send",
  { capacity: 60, refillPerSecond: 1, cost: 2 },
  async (input: z.infer<typeof UnskipInput>): Promise<UnskipDraftResult> => {
    const parsed = UnskipInput.parse(input);
    try {
      const res = await noelleFetch<DraftUnskipOut>(
        `/api/drafts/${encodeURIComponent(parsed.approvalId)}/unskip`,
        { method: "POST", body: {} },
      );
      DraftUnskipOutSchema.parse(res);
      revalidatePath(`/app/${parsed.orgSlug}/approvals`);
      revalidatePath(`/app/${parsed.orgSlug}/approvals/${parsed.approvalId}`);
      return { ok: true, status: res.status };
    } catch (e) {
      if (e instanceof NoelleApiError) {
        return { ok: false, error: { code: e.code, message: e.message, status: e.status, retry_after_ms: e.retryAfterMs } };
      }
      throw e;
    }
  },
);

const ParkInput = z.object({
  orgSlug: z.string().min(1),
  approvalId: z.string().uuid(),
});
export type ParkDraftResult =
  | { ok: true; status: import("@noelle/contracts").ApprovalStatus }
  | { ok: false; error: { code: string; message: string; status: number; retry_after_ms?: number } };

/**
 * "Wait for reply": park a DM (status -> 'deferred'). It leaves the pending
 * inbox and shows on the person's Contacts page with a "Send DM" button.
 * Shares the approvals.send bucket.
 */
export const parkDraft = withRateLimit(
  "approvals.send",
  { capacity: 60, refillPerSecond: 1, cost: 2 },
  async (input: z.infer<typeof ParkInput>): Promise<ParkDraftResult> => {
    const parsed = ParkInput.parse(input);
    try {
      const res = await noelleFetch<DraftParkOut>(
        `/api/drafts/${encodeURIComponent(parsed.approvalId)}/park`,
        { method: "POST", body: {} },
      );
      DraftParkOutSchema.parse(res);
      revalidatePath(`/app/${parsed.orgSlug}/approvals`);
      revalidatePath(`/app/${parsed.orgSlug}/approvals/${parsed.approvalId}`);
      revalidatePath(`/app/${parsed.orgSlug}/contacts`, "layout");
      return { ok: true, status: res.status };
    } catch (e) {
      if (e instanceof NoelleApiError) {
        return { ok: false, error: { code: e.code, message: e.message, status: e.status, retry_after_ms: e.retryAfterMs } };
      }
      throw e;
    }
  },
);

const ScheduleAutoSendInput = z.object({
  orgSlug: z.string().min(1),
  orgId: z.string().uuid(),
  approvalIds: z.array(z.string().uuid()).min(1).max(200),
});
export type ScheduleAutoSendActionResult =
  | { ok: true; count: number; withheld: number; firstAt: string | null; lastAt: string | null }
  | { ok: false; error: { code: string; message: string; status: number } };

/**
 * Queue a batch of picked reply approvals for staggered, jittered auto-send.
 * The api-vm stamps each with a believable target time + skips siblings; the
 * send worker fires them rate-braked. Shares the approvals.send rate bucket.
 */
export const scheduleAutoSend = withRateLimit(
  "approvals.send",
  { capacity: 60, refillPerSecond: 1, cost: 2 },
  async (
    input: z.infer<typeof ScheduleAutoSendInput>,
  ): Promise<ScheduleAutoSendActionResult> => {
    const parsed = ScheduleAutoSendInput.parse(input);
    try {
      const res = await noelleFetch<ScheduleAutoSendOut>(
        `/api/drafts/schedule-auto-send`,
        { method: "POST", body: { org_id: parsed.orgId, approval_ids: parsed.approvalIds } },
      );
      const parsedOut = ScheduleAutoSendOutSchema.parse(res);
      revalidatePath(`/app/${parsed.orgSlug}/approvals`);
      const times = res.scheduled.map((s) => s.target_at).sort();
      return {
        ok: true,
        count: parsedOut.count,
        withheld: parsedOut.withheld,
        firstAt: times[0] ?? null,
        lastAt: times[times.length - 1] ?? null,
      };
    } catch (e) {
      if (e instanceof NoelleApiError) {
        return { ok: false, error: { code: e.code, message: e.message, status: e.status } };
      }
      throw e;
    }
  },
);

const MarkSentInput = z.object({
  orgSlug: z.string().min(1),
  approvalId: z.string().uuid(),
  // Optional: the link to the reply you posted on X by hand. When present, the
  // API extracts the tweet id so the dashboard can show a live "view reply".
  tweetUrl: z.string().url().optional(),
});

export type MarkSentManualInput = z.infer<typeof MarkSentInput>;

export type MarkSentManualResult =
  | {
      ok: true;
      sentAt: string;
      draftId: string;
      /** How many sibling angles were auto-skipped (one lead, one reply). */
      siblingSkipped: number;
    }
  | {
      ok: false;
      error: {
        code: string;
        message: string;
        status: number;
        retry_after_ms?: number;
      };
    };

/**
 * Manual mark-sent: the reviewer already posted the reply on X by hand (the
 * Speedrun copy → paste flow, or a lead with no valid in_reply_to anchor).
 * POSTs to api.trynoelle.com `/api/drafts/:id/mark-sent`, which flips the
 * approval to 'sent' and skips siblings WITHOUT re-posting to X. We then
 * revalidate the inbox + detail routes so the row leaves the pending queue.
 *
 * Shares the 'approvals.send' rate-limit bucket — same "approvals work" cap.
 */
export const markSentManual = withRateLimit(
  "approvals.send",
  { capacity: 60, refillPerSecond: 1, cost: 2 },
  async (input: MarkSentManualInput): Promise<MarkSentManualResult> => {
    const parsed = MarkSentInput.parse(input);

    try {
      const res = await noelleFetch<DraftMarkSentOut>(
        `/api/drafts/${encodeURIComponent(parsed.approvalId)}/mark-sent`,
        { method: "POST", body: parsed.tweetUrl ? { tweet_url: parsed.tweetUrl } : {} },
      );
      DraftMarkSentOutSchema.parse(res);
      revalidatePath(`/app/${parsed.orgSlug}/approvals`);
      revalidatePath(`/app/${parsed.orgSlug}/approvals/${parsed.approvalId}`);
      return {
        ok: true,
        sentAt: res.sent_at,
        draftId: res.draft_id,
        siblingSkipped: res.sibling_skipped ?? 0,
      };
    } catch (e) {
      if (e instanceof NoelleApiError) {
        return {
          ok: false,
          error: {
            code: e.code,
            message: e.message,
            status: e.status,
            retry_after_ms: e.retryAfterMs,
          },
        };
      }
      throw e;
    }
  },
);

const UnmarkSentInput = z.object({
  orgSlug: z.string().min(1),
  approvalId: z.string().uuid(),
});

export type UnmarkSentManualInput = z.infer<typeof UnmarkSentInput>;

export type UnmarkSentManualResult =
  | { ok: true; status: string; restored: number }
  | { ok: false; error: { code: string; message: string; status: number; retry_after_ms?: number } };

/**
 * Undo a manual mark-sent — the transient "Undo" affordance in the inbox. POSTs
 * to `/api/drafts/:id/unmark-sent`, which reverses the send (approval back to
 * 'pending', draft un-locked, sibling angles + auto-deferred DM restored) for a
 * MANUAL send only. We then revalidate the inbox + detail routes so the row
 * returns to the actionable queue. Shares the 'approvals.send' rate bucket.
 */
export const unmarkSentManual = withRateLimit(
  "approvals.send",
  { capacity: 60, refillPerSecond: 1, cost: 2 },
  async (input: UnmarkSentManualInput): Promise<UnmarkSentManualResult> => {
    const parsed = UnmarkSentInput.parse(input);

    try {
      const res = await noelleFetch<DraftUnmarkSentOut>(
        `/api/drafts/${encodeURIComponent(parsed.approvalId)}/unmark-sent`,
        { method: "POST", body: {} },
      );
      DraftUnmarkSentOutSchema.parse(res);
      revalidatePath(`/app/${parsed.orgSlug}/approvals`);
      revalidatePath(`/app/${parsed.orgSlug}/approvals/${parsed.approvalId}`);
      return { ok: true, status: res.status, restored: res.restored };
    } catch (e) {
      if (e instanceof NoelleApiError) {
        return {
          ok: false,
          error: {
            code: e.code,
            message: e.message,
            status: e.status,
            retry_after_ms: e.retryAfterMs,
          },
        };
      }
      throw e;
    }
  },
);

// ---------------------------------------------------------------------------
// Pattern Breaker — the approvals-page popup's Revert / Refine / Acknowledge.
// All three POST to api.trynoelle.com (org-membership checked there) and
// revalidate the inbox. Refine ENQUEUES an AI rewrite (status→refining); the
// pattern-breaker worker drains it, so the next poll shows the refined rule.
// ---------------------------------------------------------------------------

const PatternAlertActionInput = z.object({
  orgSlug: z.string().min(1),
  alertId: z.string().uuid(),
});
export type PatternAlertActionInput = z.infer<typeof PatternAlertActionInput>;

const PatternRefineActionInput = PatternAlertActionInput.merge(PatternRefineInputSchema);
export type PatternRefineActionInput = z.infer<typeof PatternRefineActionInput>;

export type PatternAlertActionResult =
  | { ok: true; status: string; refineRequestId?: string | null }
  | { ok: false; error: { code: string; message: string; status: number; retry_after_ms?: number } };

function patternError(e: unknown): PatternAlertActionResult {
  if (e instanceof NoelleApiError) {
    return { ok: false, error: { code: e.code, message: e.message, status: e.status, retry_after_ms: e.retryAfterMs } };
  }
  throw e;
}

export const revertPatternAlert = withRateLimit(
  "approvals.send",
  { capacity: 60, refillPerSecond: 1, cost: 1 },
  async (input: PatternAlertActionInput): Promise<PatternAlertActionResult> => {
    const parsed = PatternAlertActionInput.parse(input);
    try {
      const res = await noelleFetch<{ status: string }>(
        `/api/pattern-alerts/${encodeURIComponent(parsed.alertId)}/revert`,
        { method: "POST", body: {} },
      );
      revalidatePath(`/app/${parsed.orgSlug}/approvals`);
      return { ok: true, status: res.status };
    } catch (e) {
      return patternError(e);
    }
  },
);

export const refinePatternAlert = withRateLimit(
  "approvals.send",
  { capacity: 60, refillPerSecond: 1, cost: 1 },
  async (input: PatternRefineActionInput): Promise<PatternAlertActionResult> => {
    const parsed = PatternRefineActionInput.parse(input);
    try {
      const res = await noelleFetch<{ status: string; refineRequestId: string | null }>(
        `/api/pattern-alerts/${encodeURIComponent(parsed.alertId)}/refine`,
        {
          method: "POST",
          body: {
            ...(parsed.note !== undefined ? { note: parsed.note } : {}),
            ...(parsed.expectedRequestId ? { expectedRequestId: parsed.expectedRequestId } : {}),
          },
        },
      );
      revalidatePath(`/app/${parsed.orgSlug}/approvals`);
      return { ok: true, status: res.status, refineRequestId: res.refineRequestId };
    } catch (e) {
      return patternError(e);
    }
  },
);

export const acknowledgePatternAlert = withRateLimit(
  "approvals.send",
  { capacity: 60, refillPerSecond: 1, cost: 1 },
  async (input: PatternAlertActionInput): Promise<PatternAlertActionResult> => {
    const parsed = PatternAlertActionInput.parse(input);
