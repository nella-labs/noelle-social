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
            }
          : {}),
      },
    });
  }
  return { comments, dms };
}

/** Priority wake is reserved for Jev-qualified browser observations. */
export function isPriorityReadyRow(row: JoinedRow): boolean {
  return (row.draft_payload?.kind == null || row.draft_payload.kind === "reply")
    && row.lead_payload?.source === "extension_observed"
    && row.lead_payload.classifier?.provider === "jev";
}

/**
 * Is this row one of the notifications actor's conversation replies?
 *
 * Both halves are required. `source='notification'` says it came from the
 * sweep; a comment urn on external_id says we actually know WHICH comment to
 * answer. Without the second, threading is impossible and the item must take
 * the ordinary post-level path — where the dedup will (correctly) drop it.
 */
function isNotificationLead(r: JoinedRow): boolean {
  const src = (r.lead_payload as { source?: string } | null)?.source;
  if (src !== "notification") return false;
  return /^urn:li:comment:\d+$/.test(String(r.lead_external_id ?? ""));
}

// Persistent dedup-by-link: drop any COMMENT whose post was already commented on.
// Keyed on the LinkedIn activity URN carried on each item's target (derived from
// the post URL by activityUrnFrom). Unlike the extension's in-memory per-run guard
// (RunState.actionedUrls) and the after-markSent sibling-skip, this blocks a
// re-comment across browser restarts, across a failed markSent, and across two
// leads that resolve to the same post. Items with no derivable URN are left as-is
// (nothing to dedup by link — rare). DMs are profile-targeted, never touched here.
export function dedupeAlreadyCommented(
  built: ActionableLinkedInResponse,
  commentedUrns: ReadonlySet<string>,
  /**
   * Lead ids the dedup must NOT drop — the items that will be THREADED.
   *
   * Pass only items carrying `target.comment_urn`, i.e. ones the actuator will
   * answer under a specific comment rather than adding to the post. That
   * distinction is the whole safety property: the original version exempted
   * every conversation reply on the reasoning that a second comment on the post
   * was by design, which is true only when the answer is threaded — and the
   * actuator could not thread, so it published five duplicate top-level
   * comments on the operator's own threads.
   *
   * Scoped to lead ids (not urns) so exempting one conversation can never let
   * an unrelated stale lead through on the same post.
   */
  exemptLeadIds?: ReadonlySet<string>,
): ActionableLinkedInResponse {
  if (commentedUrns.size === 0) return built;
  const comments = built.comments.filter(
    (c) =>
      exemptLeadIds?.has(c.lead_id) ||
      !(c.target.activity_urn && commentedUrns.has(c.target.activity_urn)),
  );
  return { comments, dms: built.dms };
}

// Pure + deterministic: decide whether to halt the LinkedIn send queue.
// flagEnabled=false => never halt (escape hatch). A null count encodes a failed
// challenge query => fail CLOSED (halt). No time/IO inside — the caller passes the
// already-computed count so this stays unit-testable.
export function shouldHaltForChallenge(opts: {
  flagEnabled: boolean;
  recentChallengeCount: number | null;
}): boolean {
  if (!opts.flagEnabled) return false;
  return opts.recentChallengeCount == null || opts.recentChallengeCount > 0;
}

// Collapse the served queue to at most `cap` WRITES per author per day and drop
// anyone already commented/DMed today. Rows MUST be newest-first (created_at desc);
// only items that survived buildActionable are counted, so a dropped draft never
// burns an author's slot. Matches BOTH lane keys (author_handle public id OR
// author_id fsd id), mirroring countSentDmsToAuthor.
export function capActionablePerAuthor(
  built: ActionableLinkedInResponse,
  rows: JoinedRow[],
  args: { cap: number; writtenHandles: ReadonlySet<string>; writtenIds: ReadonlySet<string> },
): ActionableLinkedInResponse {
  const cap = Number.isFinite(args.cap) && args.cap >= 1 ? Math.floor(args.cap) : 1; // fail-safe → 1
  const live = new Set<string>([...built.comments, ...built.dms].map((i) => i.approval_id));
  const counts = new Map<string, number>();
  const keep = new Set<string>();
  for (const r of rows) {
    if (!live.has(r.approval_id)) continue; // only count actually-served items
    const handle = (r.lead_payload?.authorPublicId ?? r.author_handle) || null;
    const id = r.author_id ?? null;
    if ((handle && args.writtenHandles.has(handle)) || (id && args.writtenIds.has(id))) continue; // already actioned today
    const key = id ?? handle ?? `lead:${r.lead_id}`; // unknown-author rows never merge
    const used = counts.get(key) ?? 0;
    if (used >= cap) continue;
    counts.set(key, used + 1);
    keep.add(r.approval_id);
  }
  return {
    comments: built.comments.filter((i) => keep.has(i.approval_id)),
    dms: built.dms.filter((i) => keep.has(i.approval_id)),
  };
}

// ---------------------------------------------------------------------------
// X actuator (apps/x-actuator): the browser twin of the LinkedIn actuator for
// x.com. Reply-only — the official X API refuses automated replies
// (docs/reply-actuation-strategy.md), so the extension polls /api/actionable-x
// and posts from the operator's own logged-in tab. X DMs are never auto-sent,
// so there is no dm branch anywhere below.
// ---------------------------------------------------------------------------

type XLeadPayload = {
  authorName?: string | null;
  posted_at?: string | null;
  source?: string;
  classifier?: { judge?: string } | null;
};
export type XJoinedRow = {
  approval_id: string;
  draft_id: string;
  lead_id: string;
  draft_payload: DraftPayload | null;
  lead_payload: XLeadPayload | null;
  author_handle: string | null; // handle without @ (noelle.leads.author_handle)
  external_id: string | null; // the tweet id (noelle.leads.external_id)
  // noelle.approvals.auto_send_target_at: non-null ⇒ this pending approval is
  // OWNED by the x-intern official-API autosend pipeline (drafter-tick stamps
  // it; send-db claimAutoSendDue claims + posts it via the official API,
  // deliberately NOT gated on auto_send_enabled). Stamped rows must NEVER be
  // served to the browser actuator: two unattended senders over the same row =
  // the same reply posted publicly twice (mark-sent idempotency only dedupes
  // the DB, not the public post). The SQL query excludes these rows at the
  // source; buildActionableX is the testable belt-and-braces. `Date` admitted
  // alongside the driver's string form (timestamp columns can surface either).
  auto_send_target_at: string | Date | null;
};

/** Priority wake is reserved for Jev-qualified browser observations with a real review. */
export function isPriorityReadyXRow(row: XJoinedRow): boolean {
  const dp = row.draft_payload;
  return (dp?.kind == null || dp.kind === "reply")
    && row.lead_payload?.source === "extension_observed"
    && row.lead_payload.classifier?.judge === "jev"
    && passesUnattendedReplyReview(dp?.verifier_meta);
}

// Pure: turns joined X rows into the actionable reply queue, mirroring
// buildActionable. onOmit is called for every dropped item so callers can log
// server-side. When blockExternalLinks is true, a reply whose body carries a
// non-x.com/t.co link is withheld. No Date/process.env inside — unit-testable.
export function buildActionableX(
  rows: XJoinedRow[],
  onOmit?: (reason: string, row: XJoinedRow) => void,
  opts?: { blockExternalLinks?: boolean },
): ActionableXResponse {
  const replies: ActionableXResponse["replies"] = [];
  for (const r of rows) {
    const dp = r.draft_payload ?? {};
    if (awaitingHumanReview(dp)) { onOmit?.("human-review-required", r); continue; }
    const lp = r.lead_payload ?? {};
    const body = readDraftBody(dp);
    if (!body) { onOmit?.("empty-body", r); continue; }
    // Partition guard (belt-and-braces with the SQL filter): an approval
    // stamped auto_send_target_at belongs to the x-intern API-autosend
    // pipeline. Serving it here would arm a SECOND unattended sender on the
    // same approval → duplicate public reply once autosend claims + posts it
    // (see XJoinedRow). Canonical omit reason: "autosend-owned".
    if (r.auto_send_target_at != null) { onOmit?.("autosend-owned", r); continue; }
    // Only "reply" (or null/undefined treated as reply) is actionable on X.
    if (dp.kind !== "reply" && dp.kind != null) { onOmit?.("unsupported-kind", r); continue; }
    const vm = dp.verifier_meta;
    if (vm == null) { onOmit?.("verify-missing", r); continue; }
    if (vm.pass !== true) { onOmit?.("verify-failed", r); continue; }
    if (vm.judgeOk !== true) { onOmit?.("verify-no-valid-judge", r); continue; }
    if (opts?.blockExternalLinks && bodyHasExternalLink(body)) { onOmit?.("external-link", r); continue; }
    const tweetId = readXSourceId(r.external_id);
    if (!tweetId) { onOmit?.("no-tweet-id", r); continue; } // cannot locate the tweet → omit
    const rawHandle = typeof r.author_handle === "string" ? r.author_handle.trim().replace(/^@/, "") : "";
    const handle = /^[A-Za-z0-9_]{1,15}$/.test(rawHandle) ? rawHandle : null;
    // Handle-less permalinks still resolve (x.com/i/status/:id redirects).
    const url = handle
      ? `https://x.com/${handle}/status/${tweetId}`
      : `https://x.com/i/status/${tweetId}`;
    replies.push({
      approval_id: r.approval_id,
      draft_id: r.draft_id,
      lead_id: r.lead_id,
      kind: "reply",
      body,
      target: {
        type: "post",
        url,
        tweet_id: tweetId,
        author_handle: handle,
        author_name: typeof lp.authorName === "string" ? lp.authorName.trim() || null : null,
      },
