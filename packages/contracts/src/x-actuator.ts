import { z } from "zod";

// Contracts for the X reply Actuator browser extension (apps/x-actuator), the
// chrome.debugger twin of the LinkedIn actuator. X is actuated through the
// browser, never the official API (see docs/reply-actuation-strategy.md): the
// extension polls GET /api/actionable-x for approved replies, posts them from
// the operator's own logged-in x.com tab, and calls the shared actuator
// mark-sent. Mirrors packages/contracts/src/actuator.ts but X-native and
// reply-only — X DMs stay manual, exactly as Vega does today (no dm items).

export const XPostTargetSchema = z.object({
  type: z.literal("post"),
  url: z.string().url(), // the tweet permalink to open + reply under
  tweet_id: z.string().nullable(), // the target tweet's numeric id, when known
  author_handle: z.string().nullable(), // e.g. "jackfriks" (no @)
  author_name: z.string().nullable(),
});

export const XReplyItemSchema = z.object({
  approval_id: z.string().uuid(),
  draft_id: z.string().uuid(),
  lead_id: z.string().uuid(),
  kind: z.literal("reply"),
  body: z.string().min(1),
  target: XPostTargetSchema,
});

// Reply-only: no dms array (X DMs are never auto-sent). Kept as an object (not a
// bare array) so future non-reply actionable kinds can be added without a
// breaking change, matching ActionableLinkedInResponseSchema's shape.
export const ActionableXResponseSchema = z.object({
  replies: z.array(XReplyItemSchema),
});

export const XActivityEventSchema = z.object({
  type: z.enum(["like", "reply", "skip"]),
  // `.nullish()` (accept null AND undefined), NOT `.optional()`: mirrors the
  // LinkedIn activity schema's batch-500 fix — an event carrying an explicit
  // JSON `null` for a field (e.g. a like on a tweet whose id couldn't be
  // resolved) would otherwise make the WHOLE batch `.parse()` throw, and none
  // of the up-to-200 events would be inserted (silently destroying the rows
  // dedup/caps read back). All four columns are nullable text in
  // noelle.x_activity and the insert path already coalesces with `?? null`.
  approval_id: z.string().uuid().nullish(),
  tweet_id: z.string().nullish(), // set for like (the liked tweet) / reply
  author_handle: z.string().nullish(),
  reason: z.string().nullish(), // set for skip (selector-not-found / challenge / cap)
  // For a "like" event, the engagement kind actually delivered on the tweet
  // (like / bookmark / repost). The actuator varies these with an inclination to a
  // plain Like (default-OFF: bookmark/repost fire only when the operator opts in);
  // absent/"like" both mean a plain heart Like. Backward-compatible; `.nullish()`
  // like the fields above so an explicit JSON null can never 500 a whole batch.
  engagement: z.enum(["like", "bookmark", "repost"]).nullish(),
  at: z.string(),
});

export const XActivityInSchema = z.object({
  session_id: z.string().uuid(),
  events: z.array(XActivityEventSchema).min(1).max(200),
});

export type XPostTarget = z.infer<typeof XPostTargetSchema>;
export type XReplyItem = z.infer<typeof XReplyItemSchema>;
export type ActionableXResponse = z.infer<typeof ActionableXResponseSchema>;
export type XActivityEvent = z.infer<typeof XActivityEventSchema>;
export type XActivityIn = z.infer<typeof XActivityInSchema>;
