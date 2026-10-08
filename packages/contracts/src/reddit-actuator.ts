import { z } from "zod";

/** Read a complete bare ID or matching fullname; never extract from arbitrary text. */
export function readRedditThingId(value: unknown, kind: "post" | "comment"): string | null {
  if (typeof value !== "string") return null;
  const id = value.trim().toLowerCase().replace(kind === "post" ? /^t3_/ : /^t1_/, "");
  return /^[a-z0-9]+$/.test(id) ? id : null;
}

function readRedditSubreddit(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const name = value.trim().replace(/^\/?r\//i, "");
  return /^[a-z0-9_]+$/i.test(name) ? name : null;
}

export interface RedditPermalink {
  url: string;
  postId: string;
  commentId: string | null;
  subreddit: string | null;
}

/** Parse supported Reddit thread/comment paths, including relative permalinks. */
export function parseRedditPermalink(value: unknown): RedditPermalink | null {
  if (typeof value !== "string") return null;
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f || code === 0x5c) return null;
  }
  const input = value.trim();
  if (!input || input.startsWith("//")) return null;
  if (!input.startsWith("/") && !/^https?:\/\//i.test(input)) return null;
  let url: URL;
  try { url = new URL(input, "https://www.reddit.com"); } catch { return null; }
  if (url.username || url.password || url.port || !["http:", "https:"].includes(url.protocol)) return null;
  const parts = url.pathname.split("/");
  if (parts.at(-1) === "") parts.pop();
  if (url.hostname === "redd.it") {
    const postId = parts.length === 2 ? readRedditThingId(parts[1], "post") : null;
    return postId && parts[1]?.toLowerCase() === postId ? { url: url.href, postId, commentId: null, subreddit: null } : null;
  }
  if (url.hostname !== "reddit.com" && !url.hostname.endsWith(".reddit.com")) return null;
  const hasSubreddit = parts[1]?.toLowerCase() === "r";
  const subreddit = hasSubreddit ? readRedditSubreddit(parts[2]) : null;
  const offset = hasSubreddit ? 3 : 1;
  if ((hasSubreddit && !subreddit) || parts[offset]?.toLowerCase() !== "comments") return null;
  const postId = readRedditThingId(parts[offset + 1], "post");
  const tail = parts.slice(offset + 2);
  if (!postId || parts[offset + 1]?.toLowerCase() !== postId || tail.length > 2) return null;
  const commentId = tail.length === 2 ? readRedditThingId(tail[1], "comment") : null;
  if (tail.length === 2 && (!commentId || tail[1]?.toLowerCase() !== commentId)) return null;
  return { url: url.href, postId, commentId, subreddit };
}

/** A declared identity must agree with its permalink; missing post IDs can be derived. */
export function resolveRedditTarget(target: {
  type: "post" | "comment";
  url: unknown;
  postId?: unknown;
  commentId?: unknown;
  subreddit?: unknown;
}): RedditPermalink | null {
  const link = parseRedditPermalink(target.url);
  if (!link) return null;
  const postId = target.postId == null ? link.postId : readRedditThingId(target.postId, "post");
  const subreddit = target.subreddit == null ? link.subreddit : readRedditSubreddit(target.subreddit);
  if (!postId || postId !== link.postId || (target.subreddit != null && !subreddit)) return null;
  if (subreddit && link.subreddit && subreddit.toLowerCase() !== link.subreddit.toLowerCase()) return null;
  if (target.type === "post" && link.commentId !== null) return null;
  if (target.type === "comment" && (!link.commentId || readRedditThingId(target.commentId, "comment") !== link.commentId)) return null;
  return { ...link, subreddit };
}

// Contracts for the Reddit reply Actuator browser extension (apps/reddit-actuator),
// the chrome.debugger sibling of the X + LinkedIn actuators. Reddit is actuated
// through the operator's own logged-in reddit.com tab (there is no server-side
// Reddit credential; Orion the intern is otherwise draft-only). The extension
// polls GET /api/actionable-reddit for approved replies, posts them, and calls
// the shared actuator mark-sent. Mirrors packages/contracts/src/x-actuator.ts,
// reply-only — Reddit DMs/original-posts stay out of scope, exactly as Orion
// drafts today.
//
// Reddit-specific vs. X: a reply target can be the source POST *or* a specific
// COMMENT in the thread. A comment permalink IS the targeting mechanism —
// navigating to it focuses that comment — so the actuator opens `url` and, for a
// comment target, replies under the comment identified by `comment_id`.

export const RedditPostTargetSchema = z.object({
  type: z.literal("post"),
  url: z.string().url(), // the post's comments-page permalink to open + reply under
  post_id: z.string().nullable(), // the target post's t3 id (t3_ stripped), when known
  subreddit: z.string().nullable(), // e.g. "SaaS" (no r/)
  author: z.string().nullable(), // the post author (no u/)
});
export type RedditPostTarget = z.infer<typeof RedditPostTargetSchema>;

export const RedditCommentTargetSchema = z.object({
  type: z.literal("comment"),
  url: z.string().url(), // the COMMENT permalink (opening it focuses that comment)
  post_id: z.string().nullable(), // parent post t3 id (t3_ stripped)
  comment_id: z.string(), // the target comment's t1 id (t1_ stripped) — required for a comment reply
  subreddit: z.string().nullable(),
  author: z.string().nullable(), // the comment author being replied to (no u/)
});
export type RedditCommentTarget = z.infer<typeof RedditCommentTargetSchema>;

export const RedditReplyTargetSchema = z.discriminatedUnion("type", [
  RedditPostTargetSchema,
  RedditCommentTargetSchema,
]);
export type RedditReplyTarget = z.infer<typeof RedditReplyTargetSchema>;

export const RedditReplyItemSchema = z.object({
  approval_id: z.string().uuid(),
  draft_id: z.string().uuid(),
  lead_id: z.string().uuid(),
  kind: z.literal("reply"),
  body: z.string().min(1),
  target: RedditReplyTargetSchema,
}).transform((item, ctx) => {
  const target = resolveRedditTarget({ type: item.target.type, url: item.target.url, postId: item.target.post_id,
    subreddit: item.target.subreddit, ...(item.target.type === "comment" ? { commentId: item.target.comment_id } : {}) });
  if (!target) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Reddit reply target does not match its permalink", path: ["target"] });
    return z.NEVER;
  }
  const normalized: RedditReplyTarget = item.target.type === "comment"
    ? { ...item.target, url: target.url, post_id: target.postId, comment_id: target.commentId!, subreddit: target.subreddit }
    : { ...item.target, url: target.url, post_id: target.postId, subreddit: target.subreddit };
  return { ...item, target: normalized };
});
export type RedditReplyItem = z.infer<typeof RedditReplyItemSchema>;

// Reply-only, kept as an object (not a bare array) so future actionable kinds can
// be added without a breaking change — matches ActionableXResponseSchema's shape.
export const ActionableRedditResponseSchema = z.object({
  replies: z.array(RedditReplyItemSchema),
});
export type ActionableRedditResponse = z.infer<typeof ActionableRedditResponseSchema>;

// Activity event types: {reply, skip, upvote}. The operator explicitly opted into
// UPVOTING — overriding the prior no-vote default — so an "upvote" event is logged
// whenever the actuator delivers an idle engagement to a post. The write side is
// UPVOTE/SAVE-ONLY: there is deliberately no "downvote" event; downvoting is never
// performed and so can never be logged. Idle engagements are hard-capped
// client-side (≤10 per rolling 15-minute window, idle-only, with a min-gap so they
// don't cluster). Automated voting is a Reddit-ToS gray area (Disrupting
// Communities / Responsible Builder) that the operator accepted; the hard cap +
// strict no-downvote stance keep it minimal and human-paced.
// The OPTIONAL `engagement` field discriminates WHICH idle engagement an "upvote"
// event actually delivered — a plain "upvote" (the default) or a post "save" (a
// private bookmark, NOT a vote; DEFAULT-OFF, operator opt-in via
// engagementWeights). It is ADDITIVE + backward-compatible: an "upvote" event
// WITHOUT the field is a plain upvote exactly as before, so old clients still
// validate. SAVE-ONLY — the enum is { upvote, save }, never a "downvote". The
// server accepts it but does not persist it (no DB column / migration).
// All nullable fields — approval_id / post_id / comment_id / subreddit / reason /
// engagement — are `.nullish()` (accept null AND undefined), NOT `.optional()`:
// the extension normally omits absent fields via conditional spreads, but a client
// that sends an explicit `null` (every one of these DB columns is nullable text)
// must not 500 the WHOLE batch — the LinkedIn actuator hit exactly this
// (activity batches all-or-nothing dropped, PR #439), so the tolerance is
// mirrored here before it can fire. approval_id keeps its `.uuid()` for any
// non-null value.
export const RedditActivityEventSchema = z.object({
  type: z.enum(["reply", "skip", "upvote"]),
  approval_id: z.string().uuid().nullish(),
  post_id: z.string().nullish(),
  comment_id: z.string().nullish(), // set when the reply targeted a comment
  subreddit: z.string().nullish(),
  reason: z.string().nullish(), // set for skip (selector-not-found / challenge / throttle / cap)
  // For an "upvote" event: the idle engagement delivered — "upvote" (a plain vote
  // arrow) or "save" (a private post-save). Absent / "upvote" both mean a plain
  // upvote (backward-compatible). SAVE-ONLY: never a "downvote".
  engagement: z.enum(["upvote", "save"]).nullish(),
  at: z.string(),
});
export type RedditActivityEvent = z.infer<typeof RedditActivityEventSchema>;

export const RedditActivityInSchema = z.object({
  session_id: z.string().uuid(),
  events: z.array(RedditActivityEventSchema).min(1).max(200),
});
export type RedditActivityIn = z.infer<typeof RedditActivityInSchema>;

/** A dispatch captures the complete queued reply before rendering normalization. */
export const RedditReplyClaimInSchema = z.object({
  instance_id: z.string().uuid(),
  reply: RedditReplyItemSchema,
}).strict().superRefine((value, ctx) => {
  if (new TextEncoder().encode(value.reply.body).byteLength > 65536) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Reddit reply exceeds its byte limit", path: ["reply", "body"] });
  }
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength > 131072) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Reddit claim exceeds its byte limit" });
  }
});
export type RedditReplyClaimIn = z.infer<typeof RedditReplyClaimInSchema>;
export const RedditReplyClaimOutSchema = z.object({ claimed: z.literal(true) }).strict();
