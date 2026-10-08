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

