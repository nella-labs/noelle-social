import { z } from "zod";

// Contracts for the notifications actor — "part 2" of the reply system.
//
// Vega/Lyra open conversations and never finish them: we reply to a stranger's
// post, they reply back, and the thread dies on our side. The actuators' "Auto
// notifications" run sweeps the platform's notifications page, keeps the
// entries that are REPLIES TO US, and POSTs them here. Each one becomes a
// noelle.leads row the intern drafter picks up with full voice grounding; the
// resulting approval flows out through the normal actionable queue and the
// SAME live run posts it in-thread.
//
// Deliberately NOT a draft/send endpoint: nothing here writes to a platform.
// It is an ingest, and the existing lead → draft → approval → actuate pipeline
// does the rest. See docs/notifications-actor.md.

/**
 * The thread around the reply we're answering, scraped from the notification
 * cell itself (no per-item navigation — opening every permalink would be slow
 * and a strong automation tell). Every field is optional: X renders the parent
 * context inline for most notifications but not all, and LinkedIn's cards
 * carry less. The drafter degrades gracefully — fewer fields just means a
 * thinner CONVERSATION block, never a failed draft.
 */
export const InboundConversationSchema = z.object({
  /** The post that started the thread (ours or theirs). */
  root_post_id: z.string().min(1).max(64).nullish(),
  root_post_text: z.string().max(4000).nullish(),
  /** OUR message they are replying to — the second turn's anchor. */
  our_reply_id: z.string().min(1).max(64).nullish(),
  our_reply_text: z.string().max(4000).nullish(),
});

export const InboundReplyItemSchema = z.object({
  /**
   * THEIR reply's platform id (X: the tweet's numeric status id; LinkedIn: the
   * comment urn, or `${activityUrn}:${authorPublicId}` when the comment has no
   * addressable urn). Lands on noelle.leads.external_id, whose UNIQUE
   * constraint is the idempotency key — re-sweeping the same notification is a
   * no-op insert, so the sweep can be as repetitive as it likes.
   */
  external_id: z.string().min(1).max(200),
  /** Their handle, @-stripped (X) or public id (LinkedIn). */
  author_handle: z.string().min(1).max(200),
  author_id: z.string().max(200).nullish(),
  /** What they actually said — the text the reply answers. */
  text: z.string().min(1).max(4000),
  /** Permalink the actuator will open to reply under. */
  url: z.string().url(),
  /** Their reply's own timestamp, ISO 8601. Feeds the reply-freshness ceiling. */
  posted_at: z.string().datetime({ offset: true }),
  conversation: InboundConversationSchema.optional(),
});

export const InboundReplyInSchema = z.object({
  instanceId: z.string().uuid(),
  platform: z.enum(["x", "linkedin"]),
  // Bounded so one sweep can't dump an unbounded batch into the drafting queue.
  items: z.array(InboundReplyItemSchema).min(1).max(50),
});

/**
 * Why an item was not enqueued. `duplicate` is the common, healthy case — the
 * sweep is deliberately repetitive and re-sends what it re-sees.
 *
 * There is no "self" reason: noelle.agent_instances carries no handle column,
 * so the server cannot know the operator's own account. Filtering our own
 * replies out of the sweep is the extension's job (it reads the handle from the
 * logged-in page).
 */
export const InboundReplySkipReasonSchema = z.enum([
  "duplicate", // already ingested (external_id conflict) — the sweep re-saw it
  "turn-cap", // this conversation already has the max notification turns
]);

export const InboundReplyResultSchema = z.object({
  external_id: z.string(),
  accepted: z.boolean(),
  reason: InboundReplySkipReasonSchema.nullish(),
});

export const InboundReplyResponseSchema = z.object({
  accepted: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
  results: z.array(InboundReplyResultSchema),
});

export type InboundConversation = z.infer<typeof InboundConversationSchema>;
export type InboundReplyItem = z.infer<typeof InboundReplyItemSchema>;
export type InboundReplyIn = z.infer<typeof InboundReplyInSchema>;
export type InboundReplySkipReason = z.infer<typeof InboundReplySkipReasonSchema>;
export type InboundReplyResult = z.infer<typeof InboundReplyResultSchema>;
export type InboundReplyResponse = z.infer<typeof InboundReplyResponseSchema>;
