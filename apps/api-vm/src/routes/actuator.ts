import { bodyLimit } from "hono/body-limit";
import { skipApproval, ApprovalMutationError } from "@noelle/runtime";
import { reserveRedditBrowserReply, readClaimedRedditPosts, readRedditReplyUsage } from "../lib/reddit-browser-reply-claims-db.js";
import { Hono, type Handler } from "hono";
import { sourceTimestampSql, xReplyAgeCutoffSql, unattendedReplyReviewSql, containsExternalLink as bodyHasExternalLink } from "@noelle/runtime";
import { readXSourceId, readXSourceTimestamp } from "@noelle/x-client";
import { awaitingHumanReview, readDraftBody } from "../lib/draft-body.js";
import { replyApprovalContextSql } from "../lib/reply-approval-context-sql.js";
export { bodyHasExternalLink };
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  passesUnattendedReplyReview,
  resolveXReplyMaxAgeHours,
  ActionableLinkedInResponseSchema,
  type ActionableLinkedInResponse,
  ActuatorEnableSendInSchema,
  ActuatorIntentAckInSchema,
  LinkedInActivityInSchema,
  ActionableXResponseSchema,
  type ActionableXResponse,
  XActivityInSchema,
  ActionableRedditResponseSchema,
  readRedditThingId,
  type ActionableRedditResponse,
  RedditActivityInSchema,
  RedditReplyClaimInSchema,
  InboundReplyInSchema,
  InboundReplyResponseSchema,
  type InboundReplyIn,
} from "@noelle/contracts";
import { buildActionableReddit, dedupeAlreadyRepliedReddit, resolveRedditDailyWriteCap, type RedditJoinedRow } from "../lib/reddit-reply-policy.js";
import { noelleDb } from "../lib/db.js";
import { requireActuatorToken, type ActuatorContext } from "../middleware/actuator.js";
import { markApprovalSent } from "./drafts.js";
import { withinSendWindow, resolveSendWindow } from "../lib/send-window.js";
import { resolveLinkedInVoiceFloor } from "./linkedin-voice-policy.js";
import { resolveBrowserReplyCap } from "../lib/browser-reply-cap.js";
import { readXBrowserReplyCap } from "../lib/x-browser-reply-cap-db.js";
import { readXBrowserReplyUsage } from "../lib/x-browser-reply-usage-db.js";
import { fetchXRepliedTweetIds } from "../lib/x-reply-evidence-db.js";
export { fetchXRepliedTweetIds };
import { reserveXBrowserReply } from "../lib/x-browser-reply-claims-db.js";
import { reserveLinkedInBrowserReply } from "../lib/linkedin-browser-reply-claims-db.js";
import { resolveNotificationMaxTurns } from "../lib/notification-replies.js";
import { queueNotificationReplies } from "../lib/notification-replies-db.js";
export { resolveNotificationMaxTurns, conversationKeyFor } from "../lib/notification-replies.js";
export { resolveXDailyWriteCap } from "../lib/browser-reply-cap.js";

type DraftPayload = {
  kind?: "reply" | "dm" | "repost";
  body?: string;
  edited_body?: string | null;
  angle?: string | null;
  dm_send_approved?: boolean;
  human_review_required?: boolean;
  human_send_approved?: boolean;
  // Post-draft verifier verdict, persisted inside noelle.drafts.payload jsonb by
  // outbound.ts (verifier_meta: payload.verifierMeta). Snake_case key, camelCase
  // inner keys. Consumed by the unattended-autosend gate below.
  verifier_meta?: {
    pass: boolean;
    judgeOk?: boolean;
    judgeProvider?: "jev" | "legacy" | "mixed" | "none";
    scores: { voice: number; grounding: number; relevance: number; format: number };
    reasons?: string[];
    attempts?: number;
  } | null;
};

type LeadPayload = {
  source?: string;
  classifier?: { provider?: string } | null;
  authorName?: string | null;
  authorPublicId?: string | null;
  // Post URL. `postUrl` was the assumed field, but LinkedIn discovery/drafter
  // actually writes the post link as `original_post_url` (with `url` a copy of
  // it). Reading only `postUrl` dropped every real reply as `no-post-url`, so
  // the actuator queue served nothing. Read all three.
  postUrl?: string | null;
  original_post_url?: string | null;
  url?: string | null;
};
export type JoinedRow = {
  approval_id: string;
  draft_id: string;
  lead_id: string;
  draft_payload: DraftPayload | null;
  lead_payload: LeadPayload | null;
  /** The lead's external_id — for a notification lead, THEIR comment urn. */
  lead_external_id?: string | null;
  author_handle: string | null;
  author_id: string | null;
  wp_name: string | null;
};

// Canonical LinkedIn activity URN from a post URL, or null. Real LinkedIn post
// links come in three shapes, and ALL of them embed the same numeric activity id:
//   .../posts/<slug>-activity-7481524546924343296-ek0Y   (the common share form)
//   .../posts/activity-7481315681691607040-IO0Y
//   .../feed/update/urn:li:activity:7300000000000000000/ (the rare urn form)
// The old `urn:li:activity:\d+` regex only matched the third → target.activity_urn
// was null for essentially every real post. Match `activity[-:]<digits>` and
// normalize to `urn:li:activity:<id>` so the id — identical to leads.external_id —
// is the stable dedup key across every URL shape.
function activityUrnFrom(url: string | null | undefined): string | null {
  if (!url) return null;
  const m = url.match(/activity[-:](\d+)/i);
  return m ? `urn:li:activity:${m[1]}` : null;
}

// Pure: turns joined DB rows into the actionable queue. DM fails closed.
// onOmit is called for every dropped item so callers can log server-side.
// `gate` is an OPTIONAL unattended-autosend precondition (P5): when present with
// requireVerify=true, the COMMENT branch drops any reply that isn't verifier-passed
// at/above voiceFloor. Undefined => byte-identical to the pre-gate behavior. Pure —
// the caller reads env and passes the resolved gate, no process.env/Date here.
export function buildActionable(
  rows: JoinedRow[],
  onOmit?: (reason: string, row: JoinedRow) => void,
  gate?: { requireVerify: boolean; voiceFloor: number },
): ActionableLinkedInResponse {
  const comments: ActionableLinkedInResponse["comments"] = [];
  const dms: ActionableLinkedInResponse["dms"] = [];
  for (const r of rows) {
    const dp = r.draft_payload ?? {};
    if (awaitingHumanReview(dp)) { onOmit?.("human-review-required", r); continue; }
    const lp = r.lead_payload ?? {};
    const body = readDraftBody(dp);
    if (!body) { onOmit?.("empty-body", r); continue; }
    const publicId = lp.authorPublicId ?? r.author_handle ?? null;
    const authorName = r.wp_name?.trim() || lp.authorName?.trim() || publicId || null;

    if (dp.kind === "dm") {
      if (dp.dm_send_approved !== true) { onOmit?.("dm-not-approved", r); continue; } // fail closed
      if (!publicId) { onOmit?.("dm-no-profile", r); continue; }
      dms.push({
        approval_id: r.approval_id,
        draft_id: r.draft_id,
        lead_id: r.lead_id,
        kind: "dm",
        body,
        target: {
          type: "profile",
          url: `https://www.linkedin.com/in/${publicId}/`,
          public_id: publicId,
          recipient_name: authorName,
        },
      });
      continue;
    }

    // Guard: only "reply" (or null/undefined treated as reply) proceeds to the comment branch.
    if (dp.kind !== "reply" && dp.kind != null) {
      onOmit?.("unsupported-kind", r);
      continue;
    }

    // reply
    const url = lp.postUrl ?? lp.original_post_url ?? lp.url ?? null;
    if (!url) { onOmit?.("no-post-url", r); continue; } // cannot locate the post → omit
    // Unattended-autosend precondition (P5): a passing verifier verdict + voice
    // floor is a HARD gate on the auto-actuated comment path. DMs are NOT gated
    // here — they already require the explicit human dm_send_approved flag above,
    // so they were never unattended. Fail CLOSED: null/malformed verifier_meta omits.
    if (gate?.requireVerify) {
      const vm = dp.verifier_meta;
      if (vm == null) { onOmit?.("verify-missing", r); continue; }       // ungraded → never auto-send
      if (vm.pass !== true) { onOmit?.("verify-failed", r); continue; }
      if (vm.judgeOk !== true) { onOmit?.("verify-no-valid-judge", r); continue; }
      if (!passesUnattendedReplyReview(vm, gate.voiceFloor)) {
        onOmit?.("verify-low-voice", r); continue;
      }
    }
    comments.push({
      approval_id: r.approval_id,
      draft_id: r.draft_id,
      lead_id: r.lead_id,
      kind: "reply",
      body,
      target: {
        type: "post",
        url,
        activity_urn: activityUrnFrom(url),
        author_name: authorName,
        // THREADING. A notification lead is somebody replying to us, and the
        // lead's external_id IS their comment's urn (the sweep captured
        // replyUrn, not our own commentUrn). Handing it to the actuator is what
        // turns "add a comment to this post" into "answer this person under
        // their comment" — the difference between a reply and a duplicate
        // top-level comment on a thread we already commented on.
        ...(isNotificationLead(r)
          ? {
              comment_urn: String(r.lead_external_id ?? ""),
              // The sweep does not carry the commenter's DISPLAY name into the
              // lead (only their public id), so this is usually null and the
              // actuator's mention check is simply skipped. Left wired because
              // the check is the cheap half of proving we opened the right
              // box — the belonging check does the load-bearing work either way.
              comment_author_name: lp.authorName ?? null,
