import { passesUnattendedReplyReview } from "@noelle/contracts";
import type { LinkedInApprovalView, PendingApprovalRow } from "./queries";
import { bodyForSelectedAngle, draftPayload, leadPayload } from "./payload-shapes";

/** Quality and target prerequisites for an unattended X reply. */
export function isXReplyReady(row: PendingApprovalRow): boolean {
  const draft = draftPayload(row.draft);
  const lead = leadPayload(row.lead);
  return row.approval.status === "pending"
    && (draft.kind == null || draft.kind === "reply")
    && !!bodyForSelectedAngle(draft)
    && !!lead.originalPostUrl
    && (draft.human_review_required !== true || draft.human_send_approved === true)
    && passesUnattendedReplyReview(draft.verifier_meta);
}

/** Quality and target prerequisites for an unattended LinkedIn comment. */
export function isLinkedInReplyReady(row: LinkedInApprovalView, voiceFloor: number | null): boolean {
  return voiceFloor !== null
    && row.status === "pending"
    && row.kind === "reply"
    && !!row.body?.trim()
    && !!row.postUrl
    && (row.humanReviewRequired !== true || row.humanSendApproved === true)
    && passesUnattendedReplyReview(row.verifierMeta, voiceFloor);
}
