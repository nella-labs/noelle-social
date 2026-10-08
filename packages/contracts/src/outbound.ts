import { z } from "zod";
import { AngleSchema, UuidSchema, TimestampSchema } from "./common.js";
import { resolveRedditTarget } from "./reddit-actuator.js";

// POST /api/outbound  (HMAC-signed; called by the noelle-vm-0 drafter pool).
// Single canonical wire shape for a freshly drafted lead + its variants.

export const OutboundPlatformSchema = z.enum(["x", "linkedin", "reddit"]);
export type OutboundPlatform = z.infer<typeof OutboundPlatformSchema>;

/** Captured review channels; request and voice fields are excluded. */
export const OutboundFactualContextSchema = z.object({
  version: z.literal(1),
  platform: OutboundPlatformSchema,
  postText: z.string().max(50_000),
  knowledgeAnchors: z.array(z.string().max(8_000)).max(32),
  authorHandle: z.string().max(512).nullable().optional(),
  operatorFacts: z.array(z.string().max(8_000)).max(32).optional(),
  conversation: z.object({
    root_post_text: z.string().max(10_000).nullable().optional(),
    our_reply_text: z.string().max(10_000).nullable().optional(),
  }).nullable().optional(),
  personProfile: z.string().max(16_000).nullable().optional(),
  imageCaption: z.string().max(16_000).nullable().optional(),
}).transform((context, ctx) => {
  if (new TextEncoder().encode(JSON.stringify(context)).byteLength > 65_536) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Saved factual context exceeds 65536 UTF-8 bytes" });
  }
  return context;
});
export type OutboundFactualContext = z.infer<typeof OutboundFactualContextSchema>;

export const OutboundVerifierMetaSchema = z.object({
  pass: z.boolean(),
  scores: z.object({
    voice: z.number(),
    grounding: z.number(),
    relevance: z.number(),
    format: z.number(),
  }),
  reasons: z.array(z.string()).max(8),
  attempts: z.number().int().nonnegative(),
  /** True only when a semantic judge returned a valid verdict. */
  judgeOk: z.boolean().optional(),
  judgeProvider: z.enum(["jev", "legacy", "mixed", "none"]).optional(),
});

export const OutboundDraftInSchema = z
  .object({
    id: z.string().min(1),
    kind: z.enum(["reply", "dm", "repost"]),
    // `angle` only carries meaning for the public reply variants
    // (empathetic / technical / contrarian). A `dm` is a single
    // cold-outreach message with no angle, so it sends `null` here.
    angle: AngleSchema.nullable(),
    body: z.string().min(1),
    charCount: z.number().int().nonnegative(),
    /** Final verdict for this exact reply angle; overrides the set verdict. */
    verifierMeta: OutboundVerifierMetaSchema.optional(),
    /** Original factual channels used by the review of this exact reply. */
    reviewContext: OutboundFactualContextSchema.optional(),
    /** Deterministic writing check for this DM body; not a grounding verdict. */
    dmVoiceCheck: z.object({
      pass: z.boolean(),
      attempts: z.number().int().nonnegative(),
      reasons: z.array(z.string()).max(8),
    }).optional(),
    // Reddit-only: the intern (Orion) can choose to reply to a specific
    // most-upvoted COMMENT in the thread rather than the source post. When
    // present with kind='comment', the api-vm persists it onto the draft payload
    // so the Reddit actuator opens the comment permalink and replies under that
    // comment. Absent / kind='post' ⇒ reply to the source post (the default,
    // and the only option for x/linkedin).
    replyTarget: z
      .object({
        kind: z.enum(["post", "comment"]),
        commentId: z.string().optional(), // t1 id (t1_ stripped) when kind='comment'
        permalink: z.string().optional(), // the comment permalink when kind='comment'
        author: z.string().optional(), // the comment author being replied to (no u/)
      })
      .optional(),
  })
  .refine((d) => d.kind === "dm" || d.angle !== null, {
    message: "angle is required for reply/repost drafts",
    path: ["angle"],
  });
export type OutboundDraftIn = z.infer<typeof OutboundDraftInSchema>;

/**
 * When the drafter is running with auto_send_enabled on the active instance,
 * it picks one of the variant drafts and includes this block on the outbound
 * payload. The api-vm route stamps `auto_send_target_at` on the matching
 * approval and skips the siblings with skip_reason='auto-send-sibling' so
 * the inbox stays clean. Omitted on the human-review path.
 */
export const OutboundAutoSendSchema = z.object({
  chosenDraftId: z.string().min(1),
  targetAt: TimestampSchema,
});
export type OutboundAutoSend = z.infer<typeof OutboundAutoSendSchema>;

export const OutboundOwnerSchema = z.object({ orgId: UuidSchema, agentInstanceId: UuidSchema });

export const OutboundInSchema = z.object({
  // New workers bind drafts to their authenticated internal organization and
  // instance. Legacy workers retain the single-active-instance fallback.
  owner: OutboundOwnerSchema.optional(),
  leadId: z.string().min(1),
  batchNumber: z.number().int().nullable(),
  platform: OutboundPlatformSchema,
  authorHandle: z.string().min(1),
  authorId: z.string().min(1),
  authorFollowers: z.number().int().nullable(),
  allowsDms: z.boolean().nullable(),
  originalPostId: z.string().min(1),
  originalPostText: z.string(),
  originalPostUrl: z.string().url(),
  /** Source post creation time; null when the source did not provide a valid time. */
  postedAt: TimestampSchema.nullable(),
  matchedTrigger: z.string().nullable(),
  drafts: z.array(OutboundDraftInSchema).min(1),
  qualityScore: z.number().nullable().optional(),
  qualityGatePassed: z.boolean().nullable().optional(),
  tier: z.enum(["T1", "T2", "T3"]).nullable().optional(),
  postKind: z.string().nullable().optional(),
  /** Correlates an operator's generation request with the resulting draft. */
  replyRequestKey: z.string().min(1).max(200).optional(),
  /** Keep this draft in review even when the agent's ordinary queue auto-drains. */
  humanReviewRequired: z.boolean().optional(),
  autoSend: OutboundAutoSendSchema.nullable().optional(),
  /**
   * Voice-anchor snippets the drafter pulled from the knowledge base to ground
   * this lead's drafts. Lead-level (the same anchors ground all variants).
   * Surfaced in the approval detail's "Context loaded" card.
   */
  anchors: z
    .array(z.object({ snippet: z.string(), score: z.number() }))
    .max(8)
    .optional(),
  /**
   * Post-draft verifier verdict (lead-level). Present only when the verifier
   * ran (NOELLE_DRAFTER_VERIFY). Persisted onto each draft's payload as
   * verifier_meta so the approval detail can show how the draft was graded and
   * whether it was regenerated. A failed draft remains visible for human
   * review, but the actor only sends replies with a passing final verdict.
   */
  verifierMeta: OutboundVerifierMetaSchema.nullable().optional(),
  /**
   * The blend of human style sources (Account Feeder) whose FORM shaped this
   * lead's drafts. Lead-level — the same exemplar set grounds every variant.
   * Present only when style injection ran (NOELLE_DRAFTER_STYLE) and exemplars
   * were selected; `blend` is each contributing account's share of the chosen
   * exemplars (weights sum to ~1, sorted desc). Persisted onto each draft's
   * payload as `style_source` so the approval UI can render a
   * "Style: kaia 75% · devon 25%" badge. Absent/empty ⇒ the reply used the
   * operator's base voice (Mars) only.
   */
  styleSource: z
    .object({
      blend: z
        .array(z.object({ handle: z.string().min(1), weight: z.number() }))
        .max(8),
    })
    .nullable()
    .optional(),
}).superRefine((body, ctx) => {
  body.drafts.forEach((draft, index) => {
    if (draft.reviewContext && draft.reviewContext.platform !== body.platform) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Saved review platform does not match outbound platform",
        path: ["drafts", index, "reviewContext", "platform"] });
    }
  });
  if (body.platform !== "reddit") return;
  const source = resolveRedditTarget({ type: "post", url: body.originalPostUrl, postId: body.originalPostId });
  if (!source) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Reddit source post does not match its permalink", path: ["originalPostUrl"] });
    return;
  }
  body.drafts.forEach((draft, index) => {
    if (draft.replyTarget?.kind !== "comment") return;
    const target = resolveRedditTarget({ type: "comment", url: draft.replyTarget.permalink,
      postId: source.postId, subreddit: source.subreddit, commentId: draft.replyTarget.commentId });
    if (!target) ctx.addIssue({ code: z.ZodIssueCode.custom,
      message: "Reddit comment target does not match the source thread", path: ["drafts", index, "replyTarget"] });
  });
});
export type OutboundIn = z.infer<typeof OutboundInSchema>;

export const OutboundCreatedSchema = z.object({
  id: UuidSchema,
  approval_id: UuidSchema,
});
export type OutboundCreated = z.infer<typeof OutboundCreatedSchema>;

// 429 response body when the platform bucket is at cap.
export const OutboundCapReachedSchema = z.object({
  platform: OutboundPlatformSchema,
  active: z.number().int().nonnegative(),
  cap: z.number().int().nonnegative(),
});
export type OutboundCapReached = z.infer<typeof OutboundCapReachedSchema>;
