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
    });
  }
  return { replies };
}

// Persistent dedup-by-link: drop any reply whose tweet was already replied to.
// Keyed on the tweet's numeric status id carried on each item's target
// (tweet_id = leads.external_id). Unlike the extension's in-memory per-run
// guard (RunState.actionedUrls), this blocks a re-reply across browser
// restarts, across a failed markSent, and across two leads that resolve to the
// same tweet — a double reply on one tweet is a prime X spam signal. Items with
// no tweet_id are left as-is (buildActionableX already omits them). Mirrors
// dedupeAlreadyCommented (LinkedIn) but X-native. Pure/testable.
export function dedupeAlreadyRepliedX(
  built: ActionableXResponse,
  repliedTweetIds: ReadonlySet<string>,
): ActionableXResponse {
  if (repliedTweetIds.size === 0) return built;
  const replies = built.replies.filter(
    (r) => !(r.target.tweet_id && repliedTweetIds.has(r.target.tweet_id)),
  );
  return { replies };
}

// Trim the served X reply queue to at most `cap` replies per author_handle/day
// including confirmed replies earlier today. Rows MUST be newest-first; only
// items that survived buildActionableX are counted. Mirrors capActionablePerAuthor
// (LinkedIn) but X has no author_id and no dms, so it keys on author_handle only.
export function capActionableXPerAuthor(
  built: ActionableXResponse,
  rows: XJoinedRow[],
  args: { cap: number; writtenCounts: ReadonlyMap<string, number> },
): ActionableXResponse {
  const cap = Number.isFinite(args.cap) && args.cap >= 1 ? Math.floor(args.cap) : 1; // fail-safe → 1
  const live = new Set(built.replies.map((i) => i.approval_id));
  const counts = new Map<string, number>();
  const keep = new Set<string>();
  for (const r of rows) {
    if (!live.has(r.approval_id)) continue; // only count actually-served items
    const handle = r.author_handle?.trim().toLowerCase() || null;
    const key = handle ?? `lead:${r.lead_id}`; // unknown-author rows never merge
    const used = (args.writtenCounts.get(key) ?? 0) + (counts.get(key) ?? 0);
    if (used >= cap) continue;
    counts.set(key, (counts.get(key) ?? 0) + 1);
    keep.add(r.approval_id);
  }
  return { replies: built.replies.filter((i) => keep.has(i.approval_id)) };
}

// Resolve an actuator daily write-cap env var, fail-SAFE. Two deliberate choices
// (deviating from the LinkedIn cap, which PR #426 flipped to unset ⇒ unlimited):
// - unset/blank stays CAPPED at the platform default — X and Reddit ban at far
//   lower write velocity than LinkedIn, so lifting this backstop must be an
//   EXPLICIT opt-in: the sentinel "off"/"unlimited" ⇒ Infinity (callers then
//   skip the usage count entirely — nothing to compare against).
// - a non-numeric or negative value collapses to the default, never NaN —
//   because `served.length > NaN` is always false, a NaN cap would silently
//   NEVER trim the queue (fail-OPEN on a ban backstop).
// Pure/testable; 0 is honored (serve nothing — the safe direction).
// X's resolver is shared with the live actor cap endpoint.

// ---------------------------------------------------------------------------
// Reddit actuator (apps/reddit-actuator): the browser sibling of the X +
// LinkedIn actuators for reddit.com. Reply-first — Orion (the Reddit intern) is
// draft-only and there is no server-side Reddit credential, so the operator's own
// logged-in reddit.com tab posts. The extension additionally performs operator-
// opt-in UPVOTES (UPVOTE-ONLY, client-side hard-capped ≤10 per rolling 15 min,
// idle-only — never a downvote; see packages/contracts/src/reddit-actuator.ts).
// The extension polls GET /api/actionable-reddit, posts each reply, calls the
// shared mark-sent, and logs {reply,skip,upvote} events to /api/reddit-activity.
//
// Reddit-specific vs. X: a reply target can be the source POST or a specific
// COMMENT in the thread. The intern signals this on the draft payload's
// `reply_target` (persisted by outbound.ts from OutboundDraftIn.replyTarget):
// kind='comment' → reply under that comment (permalink + comment_id); otherwise
// reply to the source post (its comments-page permalink). The post's identity
// (id/subreddit/author/url) comes from the joined reddit lead.
// ---------------------------------------------------------------------------

export { buildActionableReddit, bodyHasExternalRedditLink, dedupeAlreadyRepliedReddit,
  resolveRedditDailyWriteCap, type RedditJoinedRow } from "../lib/reddit-reply-policy.js";

export const actuator = new Hono<{ Variables: { actuator: ActuatorContext } }>();

actuator.use("/api/actionable-linkedin", requireActuatorToken);
actuator.use("/api/actuator/priority-ready", requireActuatorToken);

const actionableLinkedIn: Handler<{ Variables: { actuator: ActuatorContext } }> = async (c) => {
  const { orgId } = c.get("actuator");
  const priorityOnly = c.req.path === "/api/actuator/priority-ready";
  const instanceId = c.req.query("instanceId");
  if (!instanceId) return c.json({ error: "missing_instance_id" }, 400);
  const sql = noelleDb();

  // Verify the instance belongs to the configured actuator org (tenancy).
  const owns = await sql<Array<{ id: string; reply_send_enabled: boolean; auto_send_enabled: boolean; actuator_daily_reply_cap: number | null }>>`
    select id, reply_send_enabled, auto_send_enabled, actuator_daily_reply_cap from noelle.agent_instances
    where id = ${instanceId} and org_id = ${orgId} limit 1
  `;
  if (owns.length === 0) return c.json({ error: "instance_not_in_org" }, 403);
  // Consent gate, two flags, both OFF by default (serve an empty queue — still
  // 200 so the extension keeps polling):
  //   - reply_send_enabled (0081): per-run consent. The extension arms it on a
  //     manual Run/Drain and disarms it at run end (fail-closed at rest).
  //   - auto_send_enabled: STANDING lights-out consent, set from the dashboard
  //     and never touched by the extension — this is what lets the extension's
  //     unattended auto-start/auto-drain paths (which deliberately never arm
  //     reply_send_enabled) serve a queue.
  // pauseAllSending clears BOTH, so the panic stop stays a real org-wide kill.
  // Every withhold gate below (challenge breaker, working hours, caps) applies
  // to both consent paths unchanged.
  if (owns[0]!.reply_send_enabled !== true && owns[0]!.auto_send_enabled !== true) {
    return c.json(ActionableLinkedInResponseSchema.parse({ comments: [], dms: [] }));
  }

  if (priorityOnly) {
    const since = Number(c.req.query("since") ?? "0");
    const wait = Math.min(25_000, Math.max(0, Number(c.req.query("waitMs") ?? "0") || 0));
    const deadline = Date.now() + wait;
    let advanced = false;
    for (;;) {
      const latest = await sql<Array<{ at_ms: string | null }>>`
        select (extract(epoch from max(a.created_at)) * 1000)::bigint::text as at_ms
        from noelle.approvals a
        join noelle.leads l on l.id = a.lead_id
        join noelle.drafts d on d.id = a.draft_id
        where a.agent_instance_id = ${instanceId} and a.org_id = ${orgId}
          and a.status = 'pending' and l.platform = 'linkedin'
          and ${replyApprovalContextSql(sql)}
          and l.payload->>'source' = 'extension_observed'
          and l.payload->'classifier'->>'provider' = 'jev'
          and d.payload->'verifier_meta'->>'judgeOk' = 'true'
          and d.payload->'verifier_meta'->>'pass' = 'true'
      `;
      advanced = Number(latest[0]?.at_ms ?? 0) > (Number.isFinite(since) ? since : 0);
      if (advanced || Date.now() >= deadline) break;
      await new Promise<void>((resolve) => setTimeout(resolve, 1500));
    }
    if (!advanced) return c.json(ActionableLinkedInResponseSchema.parse({ comments: [], dms: [] }));
  }

  // Circuit-breaker (P5): if the actuator recorded a LinkedIn bot-challenge in the
  // last hour, halt this org's send queue — commenting/DMing into a live challenge
  // is the documented fast path to a restriction and nobody is watching. Reuses the
  // /health handler's 1-hour challenge window and the X send circuit-breaker pattern.
  // Fail-CLOSED: a query error halts. Auto-recovers once the hour elapses with no new
  // challenge. Flag defaults OFF (opt-in); enable with '1'/'true'.
  const haltOnChallenge =
    process.env.NOELLE_LINKEDIN_HALT_ON_CHALLENGE === "1" ||
    process.env.NOELLE_LINKEDIN_HALT_ON_CHALLENGE === "true";
  if (haltOnChallenge) {
    let recentChallenges: number | null = null;
    try {
      const chal = await sql<Array<{ n: number }>>`
        select count(*)::int as n from noelle.linkedin_activity
        where org_id = ${orgId}
          and reason = 'challenge'
          and created_at >= now() - interval '1 hour'
      `;
      recentChallenges = chal[0]?.n ?? 0;
    } catch (e) {
      console.warn("[actuator] challenge-halt check failed; failing closed",
        (e as Error).message);
      recentChallenges = null; // fail closed
    }
    if (shouldHaltForChallenge({ flagEnabled: true, recentChallengeCount: recentChallenges })) {
      console.warn("[actuator] LinkedIn send HALTED: recent bot-challenge",
        { org_id: orgId, recentChallenges });
      return c.json(ActionableLinkedInResponseSchema.parse({ comments: [], dms: [] }));
    }
  }

  // Server-side working-hours floor (backstops the extension's client-side
  // 23:00-06:00 curfew, scheduler.ts). A wrong-clock/DST/tampered client must
  // never make us serve writes at 3am. Disabled by default (both env unset) so
  // there is NO behavior change until an operator sets a window. When a window
  // IS configured but the values are garbage, we FAIL CLOSED (serve empty).
  const sendWindow = resolveSendWindow(
    process.env.NOELLE_LINKEDIN_SEND_WINDOW_START,
    process.env.NOELLE_LINKEDIN_SEND_WINDOW_END,
    process.env.NOELLE_LINKEDIN_TZ_OFFSET_MIN,
  );
  if (sendWindow.configured) {
    // Partial/garbage config (e.g. only START or only END set => the other is
    // NaN, never 0) fails CLOSED: a half-configured window must never widen to
    // 24h and leak 3am sends.
    if (!sendWindow.valid) {
      console.warn("[actuator] send-window misconfigured (partial/garbage); failing closed (empty queue)", {
        org_id: orgId,
        winStartRaw: process.env.NOELLE_LINKEDIN_SEND_WINDOW_START,
        winEndRaw: process.env.NOELLE_LINKEDIN_SEND_WINDOW_END,
      });
      return c.json(ActionableLinkedInResponseSchema.parse({ comments: [], dms: [] }));
    }
    if (!withinSendWindow(Date.now(), sendWindow.startHour, sendWindow.endHour, sendWindow.tzOffsetMin)) {
      console.warn("[actuator] outside send window; serving empty queue", {
        org_id: orgId,
        startHour: sendWindow.startHour,
        endHour: sendWindow.endHour,
        tzOffsetMin: sendWindow.tzOffsetMin,
      });
      return c.json(ActionableLinkedInResponseSchema.parse({ comments: [], dms: [] }));
    }
  }

  const rows = await sql<JoinedRow[]>`
    select
      a.id            as approval_id,
      d.id            as draft_id,
      l.id            as lead_id,
      d.payload       as draft_payload,
      l.payload       as lead_payload,
      l.external_id   as lead_external_id,
      l.author_handle as author_handle,
      l.author_id     as author_id,
      wp.name         as wp_name
    from noelle.approvals a
    join noelle.drafts d on d.id = a.draft_id
    join noelle.leads  l on l.id = d.lead_id
    left join noelle.linkedin_watchlist_people wp
      on wp.agent_instance_id = a.agent_instance_id
     and wp.fsd_profile_id = l.author_id
    where a.agent_instance_id = ${instanceId}
      and a.org_id = ${orgId} and l.platform = 'linkedin'
      and ${replyApprovalContextSql(sql)}
      and a.org_id = ${orgId}
      and a.status = 'pending'
    order by a.created_at desc
    limit 500 -- TODO: paginate if a pending queue ever exceeds this
  `;
  // Unattended-autosend verifier precondition (P5): read the flags via process.env
  // (matching the daily-write-cap pattern below) and pass a resolved gate into the
  // pure buildActionable. OFF by default => gate=undefined => byte-identical to today.
  const voiceFloor = resolveLinkedInVoiceFloor();
  const out = buildActionable(
    priorityOnly ? rows.filter(isPriorityReadyRow) : rows,
    (reason, r) =>
      console.warn("[actuator] item omitted:", reason, { approval_id: r.approval_id, draft_id: r.draft_id }),
    { requireVerify: true, voiceFloor },
  );

  // Persistent dedup-by-link (always on): never serve a comment for a post already
  // replied to — any session, any lead, any prior markSent outcome. Keyed on the
  // activity URN (urn:li:activity:<id>). Claims are written BEFORE the browser
  // clicks Comment and remain even if both mark-sent and activity logging fail.
  // Historical sent approvals and activity rows cover sends before claims existed.
  // Fail CLOSED: a re-comment on someone's post is the exact spam we're preventing,
  // so on a query error serve nothing (still 200 so the extension keeps polling).
  let deduped: ActionableLinkedInResponse = out;
  try {
    const repliedRows = await sql<Array<{ urn: string }>>`
      select distinct urn from (
        select activity_urn as urn
          from noelle.linkedin_reply_claims
          where org_id = ${orgId}
        union
        select activity_urn as urn
          from noelle.linkedin_activity
          where org_id = ${orgId} and type = 'comment' and activity_urn is not null
        union
        select noelle.linkedin_post_activity_urn(le.payload, le.external_id) as urn
          from noelle.approvals a
          join noelle.drafts d  on d.id = a.draft_id
          join noelle.leads  le on le.id = a.lead_id
          where a.org_id = ${orgId}
            and a.status = 'sent'
            and le.platform = 'linkedin'
            and coalesce(d.payload->>'kind', 'reply') = 'reply'
      ) s where urn is not null
    `;
    const repliedUrns = new Set(repliedRows.map((r) => r.urn));
    // Until comment-level threading is supported, notification replies use
    // the same post-level deduplication as other LinkedIn comments.
    deduped = dedupeAlreadyCommented(out, repliedUrns);
    const dropped = out.comments.length - deduped.comments.length;
    if (dropped > 0) {
      console.warn("[actuator] dedup-by-link: dropped already-replied posts", { org_id: orgId, dropped });
    }
  } catch (err) {
    console.error("[actuator] dedup-by-link query failed; serving empty queue", err);
    return c.json(ActionableLinkedInResponseSchema.parse({ comments: [], dms: [] }));
  }

  // Per-author daily write cap (opt-in; no-op unless NOELLE_LINKEDIN_PER_AUTHOR_DAILY_CAP
  // is set). Runs BEFORE the global daily-write-cap trim so it strictly tightens the queue.
  let served: ActionableLinkedInResponse = deduped;
  const perAuthorRaw = process.env.NOELLE_LINKEDIN_PER_AUTHOR_DAILY_CAP;
  if (perAuthorRaw != null && perAuthorRaw.trim() !== "") {
    const parsed = Number(perAuthorRaw);
    const cap = Number.isFinite(parsed) && parsed >= 1 ? Math.floor(parsed) : 1; // fail-safe
    try {
      const writtenRows = await sql<Array<{ author_handle: string | null; author_id: string | null }>>`
        select distinct l2.author_handle, l2.author_id
        from noelle.linkedin_activity act
        join noelle.approvals a2 on a2.id = act.approval_id
        join noelle.leads     l2 on l2.id = a2.lead_id
        where act.org_id = ${orgId}
          and act.type in ('comment', 'dm')
          and act.created_at >= date_trunc('day', now())
      `;
      const writtenHandles = new Set(writtenRows.map((r) => r.author_handle).filter((x): x is string => !!x));
      const writtenIds = new Set(writtenRows.map((r) => r.author_id).filter((x): x is string => !!x));
      served = capActionablePerAuthor(deduped, rows, { cap, writtenHandles, writtenIds });
      const withheld = (deduped.comments.length + deduped.dms.length) - (served.comments.length + served.dms.length);
      if (withheld > 0) {
        console.warn("[actuator] per-author cap trim", { org_id: orgId, cap, withheld, served: served.comments.length + served.dms.length });
      }
    } catch (err) {
      // Fail CLOSED: can't determine who was actioned today → serve nothing (still 200 so the extension keeps polling).
      console.error("[actuator] per-author cap query failed; serving empty queue", err);
      return c.json(ActionableLinkedInResponseSchema.parse({ comments: [], dms: [] }));
    }
  }

  // The operator-editable browser reply cap counts comments only. DMs remain
  // governed by their existing approval path and optional combined write cap.
  const replyCap = resolveBrowserReplyCap("linkedin", owns[0]!.actuator_daily_reply_cap);
  if (replyCap !== null) {
    const [count] = await sql<Array<{ n: number }>>`
      select count(*)::int as n from noelle.linkedin_activity
      where org_id = ${orgId} and type = 'comment' and created_at >= date_trunc('day', now())
    `;
    const available = Math.max(0, replyCap - (count?.n ?? replyCap));
    served = { ...served, comments: served.comments.slice(0, available) };
  }

  // Server-side daily write-cap backstop. Client caps are advisory (a tampered
  // or misconfigured extension can exceed them), so refuse to serve comments/DMs
  // beyond the org's remaining daily write budget. Likes are found in-feed, not
  // served here, so they stay governed client-side only.
  // Unset, blank or invalid LinkedIn daily limits retain the unlimited default.
  // An explicit environment cap enables the daily comment-and-DM budget.
  const capRaw = (process.env.NOELLE_LINKEDIN_DAILY_WRITE_CAP ?? "").trim();
  const capNum = Number(capRaw);
  const dailyCap = capRaw === "" || !Number.isFinite(capNum) ? Number.POSITIVE_INFINITY : capNum;
  const used = dailyCap === Number.POSITIVE_INFINITY
    ? 0
    : (await sql<Array<{ n: number }>>`
        select count(*)::int as n from noelle.linkedin_activity
        where org_id = ${orgId}
          and type in ('comment', 'dm')
          and created_at >= date_trunc('day', now())
      `)[0]?.n ?? 0;
  const remaining = Math.max(0, dailyCap - used);
  if (served.comments.length + served.dms.length > remaining) {
    const dms = served.dms.slice(0, remaining);
    const comments = served.comments.slice(0, Math.max(0, remaining - dms.length));
    console.warn("[actuator] daily write-cap trim", {
      org_id: orgId, cap: dailyCap, used,
      served: comments.length + dms.length,
      withheld: served.comments.length + served.dms.length - (comments.length + dms.length),
    });
    return c.json(ActionableLinkedInResponseSchema.parse({ comments, dms }));
  }
  return c.json(ActionableLinkedInResponseSchema.parse(served));
};
actuator.get("/api/actionable-linkedin", actionableLinkedIn);
actuator.get("/api/actuator/priority-ready", actionableLinkedIn);

// Reserve a post before clicking LinkedIn's Comment submit button. The saved
// lead URL is the only source for the URN; the request body is ignored. The
// unique (org_id, activity_urn) key makes a lost acknowledgment permanent and
// prevents a later run from posting the same comment again.
actuator.use("/api/actuator/claim-comment/:id", requireActuatorToken);

actuator.post("/api/actuator/claim-comment/:id", async (c) => {
  const { orgId } = c.get("actuator");
  const approvalId = c.req.param("id");
  const sql = noelleDb();
  try {
    const rows = await sql<Array<JoinedRow & {
      status: string;
      reply_send_enabled: boolean;
      auto_send_enabled: boolean;
      actuator_daily_reply_cap: number | null;
      cap_instance_id: string;
    }>>`
      select a.id as approval_id, a.status, d.id as draft_id, l.id as lead_id,
             d.payload as draft_payload, l.payload as lead_payload,
             l.external_id as lead_external_id, l.author_handle, l.author_id,
             null::text as wp_name,
             ai.reply_send_enabled, ai.auto_send_enabled, ai.actuator_daily_reply_cap,
             ai.id as cap_instance_id
      from noelle.approvals a
      join noelle.agent_instances ai on ai.id = a.agent_instance_id
      join noelle.drafts d on d.id = a.draft_id
      join noelle.leads l on l.id = d.lead_id and l.id = a.lead_id
      where a.id = ${approvalId} and a.org_id = ${orgId}
        and ai.org_id = ${orgId} and d.org_id = ${orgId}
        and l.org_id = ${orgId} and l.platform = 'linkedin'
        and ai.role = 'linkedin_intern' and ${replyApprovalContextSql(sql)}
      limit 1
    `;
    const row = rows[0];
    const voiceFloor = resolveLinkedInVoiceFloor();
    if (!row || row.status !== "pending" ||
        (row.reply_send_enabled !== true && row.auto_send_enabled !== true)) {
      return c.json({ claimed: false, reason: "not-eligible" });
    }
    const comment = buildActionable([row], undefined, { requireVerify: true, voiceFloor }).comments[0];
    const activityUrn = comment?.target.activity_urn;
    if (!activityUrn) return c.json({ claimed: false, reason: "not-eligible" });

    const rawWriteCap = (process.env.NOELLE_LINKEDIN_DAILY_WRITE_CAP ?? "").trim();
    const writeCap = Number(rawWriteCap);
    const outcome = await reserveLinkedInBrowserReply(sql, {
      orgId, instanceId: row.cap_instance_id, approvalId, draftId: row.draft_id, leadId: row.lead_id,
      activityUrn, body: comment.body, draftPayload: row.draft_payload, leadPayload: row.lead_payload,
      voiceFloor, combinedWriteCap: rawWriteCap !== "" && Number.isFinite(writeCap) ? writeCap : null,
    });
    return c.json(outcome === "claimed" ? { claimed: true } : { claimed: false, reason: outcome });
  } catch (err) {
    console.error("[actuator] comment claim failed; withholding send", err);
    return c.json({ claimed: false, reason: "claim-unavailable" }, 503);
  }
});

actuator.use("/api/drafts/:id/approve-dm", requireActuatorToken);

actuator.post("/api/drafts/:id/approve-dm", async (c) => {
  const { orgId } = c.get("actuator");
  const draftId = c.req.param("id");
  const sql = noelleDb();
  const rows = await sql<Array<{ id: string }>>`
    update noelle.drafts d
    set payload = coalesce(d.payload, '{}'::jsonb) || '{"dm_send_approved": true}'::jsonb
    from noelle.approvals a, noelle.agent_instances ai
    where d.id = ${draftId}
      and a.draft_id = d.id
      and ai.id = a.agent_instance_id
      and ai.org_id = ${orgId}
      and coalesce(d.payload->>'kind', 'reply') = 'dm'
    returning d.id
  `;
  if (rows.length === 0) return c.json({ error: "not_found_or_not_dm" }, 404);
  return c.json({ draft_id: draftId, dm_send_approved: true });
});

actuator.use("/api/linkedin-activity", requireActuatorToken);

actuator.post("/api/linkedin-activity", async (c) => {
  const { orgId } = c.get("actuator");
  const body = LinkedInActivityInSchema.parse(await c.req.json());
  const sql = noelleDb();
  const values = body.events.map((e) => ({
    org_id: orgId,
    session_id: body.session_id,
    type: e.type,
    approval_id: e.approval_id ?? null,
    activity_urn: e.activity_urn ?? null,
    author_name: e.author_name ?? null,
    reason: e.reason ?? null,
    // e.reaction (the specific LinkedIn reaction on a like) is accepted by the
    // schema and surfaced in the extension panel, but intentionally NOT persisted
    // here — no column for it yet. Add one + map it if reaction analytics are wanted.
  }));
  await sql`insert into noelle.linkedin_activity ${sql(values)}`;
  return c.json({ inserted: values.length });
});

// POST /api/actuator/mark-sent/:id — actuator-token-guarded. The browser
// extension calls this (NOT the JWT /api/drafts/:id/mark-sent) after it
// successfully posts a comment or DM to LinkedIn. The :id param is an
// approval_id (not draft_id). Tenancy is verified before acting: we confirm
// the approval belongs to the actuator-configured org before calling the
// shared markApprovalSent core, which is identical to the JWT path's
// transaction. decidedBy is set to the orgId (uuid, type-compatible with
// decided_by text/uuid column).

actuator.use("/api/actuator/mark-sent/:id", requireActuatorToken);

actuator.post("/api/actuator/mark-sent/:id", async (c) => {
  const { orgId } = c.get("actuator");
  const approvalId = c.req.param("id");
  const sql = noelleDb();

  // Verify the approval belongs to the actuator org before acting (tenancy).
  const owns = await sql<Array<{ id: string }>>`
    select a.id
    from noelle.approvals a
    join noelle.agent_instances ai on ai.id = a.agent_instance_id
    where a.id = ${approvalId}
      and ai.org_id = ${orgId}
    limit 1
  `;
  if (owns.length === 0) return c.json({ error: "not_found" }, 404);

  const res = await markApprovalSent(sql, { approvalId, orgId, decidedBy: orgId, sentVia: "extension" });
  if (!res.ok) {
    return c.json({ error: res.error, detail: res.detail }, res.status);
  }
  // The approval is already sent. Keep the claim as a permanent post-level
  // record; the status only records that the browser acknowledged the send.
  // A failed status update cannot safely undo the sent approval or release it.
  try {
    await sql`
      update noelle.linkedin_reply_claims
      set status = 'sent', sent_at = coalesce(sent_at, now())
      where org_id = ${orgId} and approval_id = ${approvalId} and status = 'claimed'
    `;
  } catch (err) {
    console.error("[actuator] claim sent-state update failed; claim remains reserved", err);
  }
  return c.json(res.result);
});

// POST /api/actuator/mark-skipped/:id — actuator-token-guarded. The extension
// calls this when a comment/DM target is PERMANENTLY gone ("This post cannot be
// displayed" / deleted profile). Nothing was posted, so it must NOT markSent —
// but the approval must leave the queue, else `buildActionable` (status='pending')
// re-serves the dead permalink on every future run and the actuator re-navigates
// to it and drops it again, forever. Sets status='skipped' (a normal terminal
// state) ONLY while still pending, so it can never clobber a 'sent'/'errored' row.
// :id is an approval_id. Tenancy verified before acting, exactly like mark-sent.
actuator.use("/api/actuator/mark-skipped/:id", requireActuatorToken);

actuator.post("/api/actuator/mark-skipped/:id", async (c) => {
  const { orgId } = c.get("actuator");
  const approvalId = c.req.param("id");
  const body = await c.req.json().catch(() => ({}));
  const reason = typeof body?.reason === "string" && body.reason.length > 0
    ? body.reason.slice(0, 80)
    : "post-unavailable";
  const sql = noelleDb();

  // Tenancy: the approval must belong to the actuator's configured org.
  const owns = await sql<Array<{ id: string }>>`
    select a.id
    from noelle.approvals a
    join noelle.agent_instances ai on ai.id = a.agent_instance_id
    where a.id = ${approvalId}
      and ai.org_id = ${orgId}
    limit 1
  `;
  if (owns.length === 0) return c.json({ error: "not_found" }, 404);

  try {
    const result = await skipApproval(sql, { orgId, approvalId, operatorId: orgId }, reason, { selectedPendingOnly: true });
    return c.json({ ok: true, approvalId, skipped: result.count > 0, reason });
  } catch (error) {
    if (error instanceof ApprovalMutationError) return c.json({ error: error.category }, 409);
    throw error;
  }
});

// GET /api/actuator/approval-state/:id — actuator-token-guarded, READ-ONLY.
// The extension's pool items can sit queued for minutes-to-hours between the
// queue fetch and the slot that posts them; in that window the approval can be
// decided elsewhere (a human skips it, or — on X — the API-autosend pipeline
// stamps auto_send_target_at and claimAutoSendDue claims + posts it). The
// extension calls this immediately before each post and FAILS CLOSED (any
// error ⇒ don't post now, retry later): a non-'pending' status or a stamped
// auto_send_target_at means the browser must NOT post — doing so would
// duplicate a reply that another sender owns or already published.
// :id is an approval_id. Tenancy verified exactly like mark-sent/mark-skipped.
actuator.use("/api/actuator/approval-state/:id", requireActuatorToken);

actuator.get("/api/actuator/approval-state/:id", async (c) => {
  const { orgId } = c.get("actuator");
  const approvalId = c.req.param("id");
  const sql = noelleDb();

  const rows = await sql<Array<{ status: string; auto_send_target_at: string | null; draft_payload: DraftPayload | null }>>`
    select a.status, a.auto_send_target_at, d.payload as draft_payload
    from noelle.approvals a
    join noelle.agent_instances ai on ai.id = a.agent_instance_id
    join noelle.drafts d on d.id = a.draft_id
    where a.id = ${approvalId}
      and ai.org_id = ${orgId}
    limit 1
  `;
  if (rows.length === 0) return c.json({ error: "not_found" }, 404);
  return c.json({
    status: rows[0]!.status === "pending" && awaitingHumanReview(rows[0]!.draft_payload) ? "deferred" : rows[0]!.status,
    autosend_pending: rows[0]!.auto_send_target_at !== null,
  });
});

// POST /api/actuator/enable-send: flip the master reply switch
// (agent_instances.reply_send_enabled, migration 0081) for one instance. The
// extension calls this with enabled=true when the operator explicitly starts a
// Run/Drain — their consent to post — so approved replies flow to the queue
// without a dashboard toggle, and enabled=false when the run ends so the system
// stays fail-closed at rest. Token-authed; org-scoped exactly like the queue and
// mark-sent routes. This does NOT create any autonomous send path — the only
// thing that posts to LinkedIn is the human-operated extension pulling the queue.
actuator.use("/api/actuator/enable-send", requireActuatorToken);

actuator.post("/api/actuator/enable-send", async (c) => {
  const { orgId } = c.get("actuator");
  const parsed = ActuatorEnableSendInSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "invalid_body" }, 400);
  const { instanceId, enabled } = parsed.data;
  const sql = noelleDb();

  // Tenancy: the instance must belong to the actuator's configured org. The
  // select also captures the PRIOR reply_send_enabled value, returned below so
  // the extension can arm transition-aware: it only ever disarms at run end a
  // switch whose enable it flipped OFF→ON itself (prior=false), never the
  // operator's standing dashboard toggle (prior=true — the flag was already ON).
