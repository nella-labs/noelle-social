import { readRedditThingId, resolveRedditTarget, type ActionableRedditResponse } from "@noelle/contracts";
import { awaitingHumanReview, readDraftBody } from "./draft-body.js";
import { resolveDailyWriteCap } from "./browser-reply-cap.js";

type RedditLeadPayload = {
  subreddit?: string | null;
  // Discovery writes the canonical comments-page permalink as `url`; the drafter
  // later mirrors it as `original_post_url`. Read both (discovery-only leads have
  // only `url`).
  url?: string | null;
  original_post_url?: string | null;
  original_post_id?: string | null;
  author_handle?: string | null;
};
// The Reddit draft payload carries an optional `reply_target` (persisted by
// outbound.ts). Its inner keys stay camelCase (the OutboundDraftIn.replyTarget
// shape stored verbatim); everything else mirrors the shared DraftPayload.
type RedditReplyTargetPayload = {
  kind?: "post" | "comment";
  commentId?: string | null;
  permalink?: string | null;
  author?: string | null;
};
type RedditDraftPayload = {
  kind?: "reply" | "dm" | "repost";
  body?: string;
  edited_body?: string | null;
  reply_target?: RedditReplyTargetPayload | null;
  human_review_required?: boolean;
  human_send_approved?: boolean;
};
export type RedditJoinedRow = {
  approval_id: string;
  draft_id: string;
  lead_id: string;
  draft_payload: RedditDraftPayload | null;
  lead_payload: RedditLeadPayload | null;
  author_handle: string | null; // post author, no u/ (noelle.leads.author_handle)
  external_id: string | null; // the post id, t3_ stripped (noelle.leads.external_id)
};

// Normalize a subreddit ("r/SaaS" → "SaaS") / username ("u/spez" → "spez") to the
// bare form the contract requires. Empty → null.
function stripPrefix(value: string | null | undefined, re: RegExp): string | null {
  const v = (value ?? "").trim().replace(re, "");
  return v || null;
}

// True if the body carries a link to a host OTHER than reddit.com/redd.it.
// Links in replies are a top-tier spam signal, so the actuator withholds
// link-bearing replies (fail-closed). Reddit-internal links are allowed. Mirrors
// the X actuator's bodyHasExternalLink but with Reddit's allow-list. Pure/testable.
export function bodyHasExternalRedditLink(body: string): boolean {
  const urlRe = /https?:\/\/([^\s/]+)/gi;
  let m: RegExpExecArray | null;
  while ((m = urlRe.exec(body)) !== null) {
    const host = (m[1] ?? "").toLowerCase().replace(/^www\./, "");
    const ok =
      host === "reddit.com" || host.endsWith(".reddit.com") ||
      host === "redd.it" || host.endsWith(".redd.it");
    if (!ok) return true;
  }
  return false;
}

// Reddit daily write-cap: default 8 (docs/reddit-actuator.md: below the >10/week
// velocity flag Reddit shadowbans young accounts on). Same fail-SAFE core as the
// X resolver: non-numeric/negative (e.g. "eight") ⇒ 8 (never NaN → never
// fail-open), 0 honored, unset stays capped; ONLY the explicit "off"/"unlimited"
// sentinel lifts the cap (ports #426's opt-in-unlimited, not its unset ⇒
// unlimited default). The client-side floors (spacing, hourly burst, replies/day
// clamp) remain the residual backstop when unlimited.
export function resolveRedditDailyWriteCap(raw: string | undefined | null): number {
  return resolveDailyWriteCap(raw, 8);
}

// Pure: turns joined Reddit rows into the actionable reply queue, mirroring
// buildActionableX. onOmit is called for every dropped item so callers can log
// server-side. A reply_target.kind==='comment' builds a COMMENT target (the
// comment permalink + t1 id); otherwise a POST target (the source post's
// comments permalink). When blockExternalLinks is true, a reply whose body
// carries a non-reddit link is withheld. No Date/process.env inside — unit-testable.
export function buildActionableReddit(
  rows: RedditJoinedRow[],
  onOmit?: (reason: string, row: RedditJoinedRow) => void,
  opts?: { blockExternalLinks?: boolean },
): ActionableRedditResponse {
  const replies: ActionableRedditResponse["replies"] = [];
  for (const r of rows) {
    const dp = r.draft_payload ?? {};
    if (awaitingHumanReview(dp)) { onOmit?.("human-review-required", r); continue; }
    const lp = r.lead_payload ?? {};
    const body = readDraftBody(dp);
    if (!body) { onOmit?.("empty-body", r); continue; }
    // Only "reply" (or null/undefined treated as reply) is actionable on Reddit.
    if (dp.kind !== "reply" && dp.kind != null) { onOmit?.("unsupported-kind", r); continue; }
    if (opts?.blockExternalLinks && bodyHasExternalRedditLink(body)) { onOmit?.("external-link", r); continue; }

    const declaredIds = [r.external_id, lp.original_post_id]
      .filter(id => id != null).map(id => readRedditThingId(id, "post"));
    const sourceLinks = [lp.url, lp.original_post_url].filter(url => url != null)
      .map(url => resolveRedditTarget({ type: "post", url, postId: declaredIds[0], subreddit: lp.subreddit }));
    if (declaredIds.some(id => !id) || new Set(declaredIds).size > 1
      || sourceLinks.some(link => !link) || new Set(sourceLinks.map(link => link?.postId)).size > 1
      || new Set(sourceLinks.flatMap(link => link?.subreddit ? [link.subreddit.toLowerCase()] : [])).size > 1) {
      onOmit?.("incoherent-source-post", r); continue;
    }
    const source = sourceLinks[0] ?? null;
    const postId = declaredIds[0] ?? source?.postId ?? null;
    const subreddit = lp.subreddit ?? source?.subreddit;
    const rt = dp.reply_target ?? null;

    if (rt?.kind === "comment") {
      // Comment target: the t1 id AND a resolvable permalink are both required —
      // fail CLOSED (omit) rather than reply to the wrong place.
      const commentId = readRedditThingId(rt.commentId, "comment");
      if (!commentId) { onOmit?.("no-comment-id", r); continue; }
      if (!rt.permalink) { onOmit?.("no-comment-permalink", r); continue; }
      const target = postId ? resolveRedditTarget({ type: "comment", url: rt.permalink,
        postId, commentId, subreddit }) : null;
      if (!target) { onOmit?.("incoherent-comment-target", r); continue; }
      replies.push({
        approval_id: r.approval_id,
        draft_id: r.draft_id,
        lead_id: r.lead_id,
        kind: "reply",
        body,
        target: {
          type: "comment",
          url: target.url,
          post_id: target.postId,
          comment_id: commentId,
          subreddit: target.subreddit,
          author: stripPrefix(rt.author, /^\/?u\//i),
        },
      });
      continue;
    }

    // Post target (default; also any non-comment reply_target). Reply under the
    // source post's comments page. Omit if the permalink can't be resolved.
    if (!source) { onOmit?.("no-post-url", r); continue; }
    replies.push({
      approval_id: r.approval_id,
      draft_id: r.draft_id,
      lead_id: r.lead_id,
      kind: "reply",
      body,
      target: {
        type: "post",
        url: source.url,
        post_id: source.postId,
        subreddit: source.subreddit,
        author: stripPrefix(r.author_handle ?? lp.author_handle, /^\/?u\//i),
      },
    });
  }
  return { replies };
}

// Persistent dedup-by-thread: drop any reply whose target THREAD was already
// replied to. The Reddit sibling of dedupeAlreadyCommented above, keyed on the
// bare t3 post id carried on each item's target (target.post_id, derived from
// leads.external_id / payload.original_post_id) — a comment-target reply carries
// its PARENT post's id, so the dedup grain is the thread: two comments by one
// account in one thread is a classic subreddit-ban trigger. Unlike the
// extension's in-memory per-run guard (RunState.actionedKeys), this blocks a
// re-reply across browser restarts, across a failed markSent, and across two
// leads that resolve to the same thread. Items with no post_id are left as-is
// (nothing to dedup by — rare). Pure/testable.
export function dedupeAlreadyRepliedReddit(
  built: ActionableRedditResponse,
  repliedPostIds: ReadonlySet<string>,
): ActionableRedditResponse {
  if (repliedPostIds.size === 0) return built;
  return {
    replies: built.replies.filter((r) => !(r.target.post_id && repliedPostIds.has(r.target.post_id))),
  };
}
