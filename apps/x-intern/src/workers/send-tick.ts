import type { Logger } from "../lib/logger.js";
import type { XClient } from "../lib/x-client.js";
import type { XReplyClaim } from "@noelle/runtime";
import { XWriteUncertainError, XWritePreparationError, isDefiniteXWriteRejection } from "@noelle/x-client";
import {
  XAuthError,
  XRateLimitError,
  XLockError,
  XChallengeError,
  XReplyRestrictedError,
  XError,
} from "../lib/x-client.js";

/**
 * Consecutive reply-restriction 403s inside ONE tick before the batch is
 * abandoned as systemic. One such 403 is a per-conversation condition (the
 * author limited who can reply) and only that row errors; a run of them means
 * the ACCOUNT/APP has lost reply permission (2026-07-11: 65/65 identical 403s
 * mass-errored 118 approvals) and burning more rows proves nothing.
 */
export const REPLY_FORBIDDEN_TRIP = 2;

export interface PendingDraft {
  draft_id: string;
  body: string;
  in_reply_to_id: string;
  lead_id: string;
  /** Who flipped the approval to 'sent' — 'auto-send' for claimed rows, the
   *  operator id for Send-button clicks. Optional: only the retry queue selects
   *  it (the link guard must never revert a human-approved link reply). */
  decided_by?: string | null;
}

/**
 * One per pending draft after `runSendTick` finishes.
 *
 *   sent        — X accepted the reply; `sentExternalId` + `sentUrl` populated.
 *   errored     — permanent failure (4xx other than auth/429). approval row should
 *                 flip to status='errored' so the dashboard doesn't loop on it.
 *   auth_failed — cookies are dead. Caller should reset the readyCache and
 *                 leave the approval in 'sent' status — a future tick with
 *                 refreshed cookies will retry.
 *   rate_limited — X told us to slow down. Caller logs + leaves the row.
 *                 Next tick will try again (idempotent on sent_external_id).
 */
export type SendOutcomeStatus =
  | "sent"
  | "errored"
  | "auth_failed"
  | "rate_limited"
  | "withheld"
  | "claim_unavailable"
  | "preparation_failed"
  | "uncertain"
  // X refused the reply itself (who-can-reply / not-mentioned 403). The row
  // errors, but REPLY_FORBIDDEN_TRIP consecutive ones abandon the batch —
  // caller cools down + alerts instead of erroring the whole queue.
  | "reply_forbidden"
  // Account-level stop signals — caller must HARD-STOP the worker + alert a
  // human, never retry or flip the row to 'errored'.
  | "locked"
  | "challenged";

export interface SendOutcome {
  draftId: string;
  /** Lead this draft belongs to — the bus correlation id for draft.sent. */
  leadId?: string;
  status: SendOutcomeStatus;
  sentExternalId?: string;
  sentUrl?: string;
  /** Free-form error text for errored/auth_failed/rate_limited. */
  reason?: string;
  /**
   * Set true ONLY on the reply_forbidden outcome whose CONSECUTIVE streak
   * reached REPLY_FORBIDDEN_TRIP and broke the batch — i.e. the account/app
   * has lost reply permission wholesale, not a one-off per-conversation
   * restriction. The caller keys its systemic cooldown/alert off this flag,
   * NOT off a total count of reply_forbidden rows (two unrelated per-thread
   * 403s with a successful send between them are NOT systemic).
   */
  systemic?: boolean;
}

export interface RunSendTickArgs {
  log: Logger;
  pendingDrafts: PendingDraft[];
  xClient: XClient;
  reserveReply?: (draft: PendingDraft) => Promise<XReplyClaim | null>;
  releaseReply?: (claim: XReplyClaim) => Promise<unknown>;
  markUncertain?: (args: {
    draftId: string;
    reason: string;
    receipt?: { id: string; url: string };
  }) => Promise<void>;
  markSent: (args: {
    draftId: string;
    sentExternalId: string;
    sentUrl: string;
  }) => Promise<void>;
  /**
   * Called for permanent failures (status='errored'). Best-effort: failure
   * to flip the approval row should NOT throw out of the tick.
   */
  markErrored: (args: { draftId: string; reason: string }) => Promise<void>;
}

export async function runSendTick(args: RunSendTickArgs): Promise<SendOutcome[]> {
  const outcomes: SendOutcome[] = [];
  let replyForbiddenStreak = 0;
  for (const draft of args.pendingDrafts) {
    let claim: XReplyClaim | null = null;
    if (args.reserveReply) {
      try {
        claim = await args.reserveReply(draft);
      } catch {
        args.log.error({ draftId: draft.draft_id }, "reply reservation unavailable; withholding dispatch");
        outcomes.push({ draftId: draft.draft_id, status: "claim_unavailable", reason: "reply reservation unavailable" });
        break;
      }
      if (!claim) {
        outcomes.push({ draftId: draft.draft_id, status: "withheld", reason: "target already claimed or draft no longer eligible" });
        continue;
      }
    }
    let receipt: { id: string; url: string } | undefined;
    try {
      const tweet = await args.xClient.createTweet({
        inReplyToId: draft.in_reply_to_id,
        text: draft.body,
      });
      receipt = { id: tweet.id, url: tweet.url };
      await args.markSent({
        draftId: draft.draft_id,
        sentExternalId: tweet.id,
        sentUrl: tweet.url,
      });
      outcomes.push({
        draftId: draft.draft_id,
        leadId: draft.lead_id,
        status: "sent",
        sentExternalId: tweet.id,
        sentUrl: tweet.url,
      });
      replyForbiddenStreak = 0;
    } catch (err) {
      if (!receipt && err instanceof XWritePreparationError) {
        if (claim && args.releaseReply) await args.releaseReply(claim).catch(() => {
          args.log.error({ draftId: draft.draft_id }, "pre-dispatch target release failed; reservation retained");
        });
        args.log.error({ draftId: draft.draft_id }, err.message);
        outcomes.push({ draftId: draft.draft_id, status: "preparation_failed", reason: err.message });
        break;
      }
      const definiteRejection = isDefiniteXWriteRejection(err);
      if (receipt || err instanceof XWriteUncertainError || !definiteRejection) {
        const knownReceipt = receipt ?? (err instanceof XWriteUncertainError ? err.receipt : undefined);
        const reason = receipt ? "reply accepted; receipt persistence requires reconciliation" : "reply dispatch outcome requires reconciliation";
        args.log.error({ draftId: draft.draft_id, sentExternalId: knownReceipt?.id }, reason);
        try {
          await args.markUncertain?.({ draftId: draft.draft_id, reason, ...(knownReceipt ? { receipt: knownReceipt } : {}) });
        } catch {
          args.log.error({ draftId: draft.draft_id }, "reconciliation persistence unavailable; target claim retained");
        }
        outcomes.push({ draftId: draft.draft_id, leadId: draft.lead_id, status: "uncertain", reason,
          ...(knownReceipt ? { sentExternalId: knownReceipt.id, sentUrl: knownReceipt.url } : {}) });
        break;
      }
      if (claim && args.releaseReply) {
        try {
          await args.releaseReply(claim);
        } catch {
          args.log.error({ draftId: draft.draft_id }, "definite rejection reservation release failed; target remains withheld");
        }
      }
      if (err instanceof XLockError || err instanceof XChallengeError) {
        const locked = err instanceof XLockError;
        args.log.error(
          { draftId: draft.draft_id, err: err.message },
          locked
            ? "send hit an account LOCK / automation flag — hard stop, no retry"
            : "send hit a human challenge — hard stop, no retry",
        );
        // CRITICAL: do NOT markErrored (that's per-draft) and do NOT continue.
        // The account is the problem, not the draft. Caller pauses + alerts.
        outcomes.push({
          draftId: draft.draft_id,
          status: locked ? "locked" : "challenged",
          reason: err.message,
        });
        break;
      }
      if (err instanceof XAuthError) {
        args.log.error(
          { draftId: draft.draft_id, err: err.message },
          "send failed (auth) — caller should reset cookie cache",
        );
        outcomes.push({
          draftId: draft.draft_id,
          status: "auth_failed",
          reason: err.message,
        });
        // Stop the batch — every subsequent call will also fail until cookies refresh.
        break;
      }
      if (err instanceof XReplyRestrictedError) {
        replyForbiddenStreak += 1;
        args.log.error(
          { draftId: draft.draft_id, streak: replyForbiddenStreak, err: err.message },
          "send refused: X reply-restriction 403 — erroring this row",
        );
        try {
          await args.markErrored({ draftId: draft.draft_id, reason: err.message });
        } catch (markErr) {
          args.log.error(
            { draftId: draft.draft_id, err: (markErr as Error).message },
            "markErrored callback threw",
          );
        }
        const systemic = replyForbiddenStreak >= REPLY_FORBIDDEN_TRIP;
        outcomes.push({
          draftId: draft.draft_id,
          leadId: draft.lead_id,
          status: "reply_forbidden",
          reason: err.message,
          systemic,
        });
        if (systemic) {
          // The account/app can't reply at all. Stop consuming the queue — the
          // caller keys its cooldown/alert off this row's `systemic` flag, and
          // releases unattempted claims back to the review inbox.
          args.log.error(
            { streak: replyForbiddenStreak },
            "consecutive reply-restriction 403s — abandoning batch as systemic",
          );
          break;
        }
        continue;
      }
      replyForbiddenStreak = 0;
      if (err instanceof XRateLimitError) {
        args.log.warn(
          { draftId: draft.draft_id, err: err.message },
          "send rate-limited — leaving approval as 'sent' for retry next tick",
        );
        outcomes.push({
          draftId: draft.draft_id,
          status: "rate_limited",
          reason: err.message,
        });
        // Stop the batch — pounding more requests just makes the rate-limit longer.
        break;
      }
      const message =
        err instanceof XError ? err.message : (err as Error).message;
      args.log.error(
        { draftId: draft.draft_id, err: message },
        "send failed — flipping approval to errored",
      );
      try {
        await args.markErrored({ draftId: draft.draft_id, reason: message });
      } catch (markErr) {
        args.log.error(
          { draftId: draft.draft_id, err: (markErr as Error).message },
          "markErrored callback threw",
        );
      }
      outcomes.push({
        draftId: draft.draft_id,
        status: "errored",
        reason: message,
      });
    }
  }
  return outcomes;
}
