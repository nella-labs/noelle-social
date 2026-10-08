import { passesUnattendedReplyReview, type OutboundIn, type OutboundPlatform } from "@noelle/contracts";
import { readSourceTimestamp } from "@noelle/runtime/source-values";

type ReplyReview = NonNullable<OutboundIn["verifierMeta"]>;

function automaticReviewSkipReason(
  review: ReplyReview | null | undefined,
  voiceFloor?: number,
): string | null {
  if (passesUnattendedReplyReview(review, voiceFloor)) return null;
  if (!review) return "automatic-review-missing";
  if (review.pass !== true) return "automatic-review-failed";
  if (review.judgeOk !== true) return "automatic-review-invalid-judge";
  if (voiceFloor !== undefined) return "automatic-review-low-voice";
  return "automatic-review-failed";
}

export type OutboundStoredDraft = { id: string; payload: Record<string, unknown> };

export function outboundLeadPayload(payload: OutboundIn) {
  return {
    batch_number: payload.batchNumber,
    platform: payload.platform,
    author_handle: payload.authorHandle,
    author_id: payload.authorId,
    author_followers: payload.authorFollowers,
    allows_dms: payload.allowsDms,
    original_post_id: payload.originalPostId,
    original_post_text: payload.originalPostText,
    original_post_url: payload.originalPostUrl,
    posted_at: readSourceTimestamp(payload.postedAt),
    matched_trigger: payload.matchedTrigger,
    quality_score: payload.qualityScore ?? null,
    quality_gate_passed: payload.qualityGatePassed ?? null,
    tier: payload.tier ?? null,
    post_kind: payload.postKind ?? null,
    anchors: payload.anchors ?? null,
  };
}

export function outboundDraftRows(payload: OutboundIn) {
  return payload.drafts.map((d) => ({
    id: d.id,
    payload: {
      kind: d.kind,
      angle: d.angle,
      body: d.body,
      char_count: d.charCount,
      ...(d.reviewContext ? { review_context: d.reviewContext } : {}),
      ...(payload.replyRequestKey ? { reply_request_key: payload.replyRequestKey } : {}),
      ...(d.kind === "dm" ? { human_review_required: true } : {}),
      // Reply-set scores cannot certify a companion DM, especially after a
      // DM-only rewrite. Persist the check that ran on that actual DM instead.
      ...(d.kind !== "dm" && (d.verifierMeta ?? payload.verifierMeta)
        ? { verifier_meta: d.verifierMeta ?? payload.verifierMeta }
        : {}),
      ...(d.kind === "dm" && d.dmVoiceCheck ? { dm_voice_check: d.dmVoiceCheck } : {}),
      // Lead-level Account-Feeder style-source blend (when style injection ran)
      // stashed per draft so the approval card can show a "Style: …" badge.
      // Omitted when absent ⇒ the reply used the base voice only.
      ...(payload.styleSource ? { style_source: payload.styleSource } : {}),
      // Reddit-only: the intern's per-draft reply target (source post vs. a
      // specific most-upvoted comment). Stored verbatim under `reply_target` so
      // the Reddit actuator (buildActionableReddit) can open the comment
      // permalink and reply under that comment. Absent for x/linkedin drafts.
      ...(d.replyTarget ? { reply_target: d.replyTarget } : {}),
    },
  }));
}

/** Approval decisions use the exact stored draft, including any later review enrichment. */
export function outboundApprovalRows(drafts: OutboundStoredDraft[], owner: { org_id: string; agent_instance_id: string },
  leadId: string, platform: OutboundPlatform, voiceFloor?: number) {
  const decidedAt = new Date().toISOString();
  let selectedReply = false;
  return drafts.map((d) => {
    if (!(platform === "x" || platform === "linkedin") || d.payload.kind !== "reply") {
      return {
        org_id: owner.org_id,
        agent_instance_id: owner.agent_instance_id,
        draft_id: d.id,
        lead_id: leadId,
        status: "pending" as const,
        decided_at: null,
        decided_by: null,
        skip_reason: null,
      };
    }

    const review = d.payload.verifier_meta as ReplyReview | undefined;
    const reviewFailure = automaticReviewSkipReason(review, voiceFloor);
    const skipReason = reviewFailure ?? (selectedReply ? "automatic-review-sibling" : null);
    if (!skipReason) selectedReply = true;
    return {
      org_id: owner.org_id,
      agent_instance_id: owner.agent_instance_id,
      draft_id: d.id,
      lead_id: leadId,
      status: skipReason ? "skipped" as const : "pending" as const,
      decided_at: skipReason ? decidedAt : null,
      decided_by: skipReason ? "automatic-review" : null,
      skip_reason: skipReason,
    };
  });
}
