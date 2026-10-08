import { z } from "zod";
import { UuidSchema, TimestampSchema } from "./common.js";
import { OutboundOwnerSchema } from "./outbound.js";

// Posts lane wire shapes. The Posts lane is two-stage and generate-on-demand:
//   1. ideation worker → idea cards (POST /api/post-ideas, HMAC)
//   2. operator clicks Generate → POST /api/posts/:ideaId/generate (JWT)
//   3. post-drafter worker writes the full draft (back through /api/outbound-
//      style write — but to post_drafts; handled in routes/posts.ts)
//   4. operator review: chat-regen / pin / mark-ready / dismiss (JWT)
//
// Platform for original content. The Content workspace spans all three growth
// interns: linkedin (Lyra), x (Vega), reddit (Orion). Distinct from the
// reply/DM lanes; this is the original-post pipeline.
export const PostPlatformSchema = z.enum(["linkedin", "x", "reddit"]);
export type PostPlatform = z.infer<typeof PostPlatformSchema>;

export const PostIdeaStatusSchema = z.enum([
  "proposed",
  "approved",
  "drafting",
  "drafted",
  "ready",
  "published",
  "dismissed",
]);
export type PostIdeaStatus = z.infer<typeof PostIdeaStatusSchema>;

export const PostDraftStatusSchema = z.enum(["draft", "ready", "published", "dismissed"]);
export type PostDraftStatus = z.infer<typeof PostDraftStatusSchema>;

// A pointer to the source that inspired an idea, surfaced as an "inspired by"
// link in the UI. At least one of leadId / url should be present for it to be
// clickable; a playbook ref may carry only an author.
export const InspirationRefSchema = z.object({
  kind: z.enum(["watchlist_post", "keyword_post", "replied_post", "playbook", "vault"]),
  leadId: z.string().optional(),
  url: z.string().url().optional(),
  author: z.string().optional(),
  note: z.string().max(280).optional(),
});
export type InspirationRef = z.infer<typeof InspirationRefSchema>;

// One idea card as produced by the ideation worker. The drafter supplies a
// stable `id` so retries dedupe (ON CONFLICT (id) DO NOTHING), mirroring drafts.
export const PostIdeaInSchema = z.object({
  // The column is uuid; producers (the ideation worker via randomUUID, or a
  // skill via the bridge) MUST supply a UUID so retries dedupe on it.
  id: UuidSchema,
  // The idea's HOME platform — resolves the owning instance. The idea itself is
  // cross-platform; the home platform is just who owns the row.
  platform: PostPlatformSchema,
  // The platforms this idea fans out into (one draft per entry). Absent ⇒ the
  // route defaults to [platform] (legacy single-platform behavior).
  targetPlatforms: z.array(PostPlatformSchema).min(1).max(3).optional(),
  hook: z.string().min(1).max(600),
  thesis: z.string().max(1200).nullable().optional(),
  angle: z.string().max(60).nullable().optional(),
  pillar: z.string().max(120).nullable().optional(),
  inspirationRefs: z.array(InspirationRefSchema).max(12).default([]),
  // ISO date (YYYY-MM-DD) for the weekly-batch Mon-Sun slot; null for singles.
  suggestedDay: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullable()
    .optional(),
  batchId: z.string().min(1).nullable().optional(),
  sourceEngine: z.string().nullable().optional(),
  model: z.string().nullable().optional(),
});
export type PostIdeaIn = z.infer<typeof PostIdeaInSchema>;

// POST /api/post-ideas (HMAC) — the ideation worker pushes a batch of idea
// cards. agentInstanceId resolved server-side from the platform, like outbound.
export const PostIdeasCreateSchema = z
  .object({
    platform: PostPlatformSchema,
    ideas: z.array(PostIdeaInSchema).min(1).max(20),
    ideationRequestId: UuidSchema.optional(),
  })
  // The route resolves a single owning instance from the batch `platform`, then
  // stores each idea's own `platform`. If they diverged, rows would be owned by
  // one intern but labelled another platform — so require them to match.
  .refine((d) => d.ideas.every((i) => i.platform === d.platform), {
    message: "every idea.platform must equal the batch platform",
    path: ["ideas"],
  });
export type PostIdeasCreate = z.infer<typeof PostIdeasCreateSchema>;

export const PostIdeasCreatedSchema = z.object({
  idea_ids: z.array(UuidSchema),
});
export type PostIdeasCreated = z.infer<typeof PostIdeasCreatedSchema>;

const creationOwnerSchema = OutboundOwnerSchema.partial();
const creationOwnerFields = creationOwnerSchema.shape;
function completeCreationOwner(
  owner: z.infer<typeof creationOwnerSchema>,
): boolean {
  return (owner.orgId === undefined) === (owner.agentInstanceId === undefined);
}
const creationOwnerIssue = {
  message: "orgId and agentInstanceId must be supplied together",
  path: ["agentInstanceId"],
};

// POST /api/posts/ideate (JWT) — operator triggers an ideation run. `single`
// produces a handful of on-demand ideas; `batch` produces ~7 mapped Mon-Sun.
export const IdeationTriggerInSchema = z.object({
  ...creationOwnerFields,
  mode: z.enum(["single", "batch"]).default("single"),
  // For single mode: how many ideas to ask for (1-10). Ignored for batch (=7).
  count: z.number().int().min(1).max(10).optional(),
  // Optional topic guidance for synthesis from saved context.
  topics: z.array(z.string().min(1)).max(20).optional(),
  // Monday (YYYY-MM-DD) the weekly batch starts on. Defaults to the next Monday.
  weekStart: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  // The lane the operator triggered from — routes to that platform's intern
  // (x → Vega, linkedin → Lyra) and scopes which engine ideates. Absent ⇒ the
  // cross-platform "All" view, which the route maps to linkedin (Lyra) + a
  // linkedin+x fan-out. reddit is rejected (Orion drafts replies, not posts).
  platform: PostPlatformSchema.optional(),
  // The platforms the produced ideas fan out into. Absent ⇒ the route derives it
  // from `platform` (a single-platform lane → [platform]; All → [linkedin, x]).
  targetPlatforms: z.array(PostPlatformSchema).min(1).max(3).optional(),
}).refine(completeCreationOwner, creationOwnerIssue);
export type IdeationTriggerIn = z.infer<typeof IdeationTriggerInSchema>;

export const IdeationTriggerOutSchema = z.object({
  enqueued: z.boolean(),
  mode: z.enum(["single", "batch"]),
  batch_id: UuidSchema.nullable(),
});
export type IdeationTriggerOut = z.infer<typeof IdeationTriggerOutSchema>;

// Operator-authored idea: the operator types their own hook (and optionally a
// thesis/angle/pillar), it lands as a `proposed` idea they can then Generate.
export const ManualIdeaInSchema = z.object({
  ...creationOwnerFields,
  // The operator's own brief — generous cap so a full paragraph isn't truncated.
  hook: z.string().min(1).max(3000),
  thesis: z.string().max(1200).nullable().optional(),
  angle: z.string().max(60).nullable().optional(),
  pillar: z.string().max(120).nullable().optional(),
  // Optional day to slot it into on the weekly calendar (YYYY-MM-DD).
  suggestedDay: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullable()
    .optional(),
  // The lane the operator authored from — sets the idea's HOME platform (which
  // intern owns + drafts it: x → Vega, linkedin → Lyra). Absent ⇒ linkedin (the
  // cross-platform "All" lane). reddit is rejected (Orion drafts replies).
  platform: PostPlatformSchema.optional(),
  // Which platforms this idea fans out into. Lets the operator make a platform-
  // specific idea (X-only, a Reddit post, etc.). Absent ⇒ the route default
  // (a single-platform lane → [platform]; All → [linkedin, x]).
  targetPlatforms: z.array(PostPlatformSchema).min(1).max(3).optional(),
}).refine(completeCreationOwner, creationOwnerIssue);
export type ManualIdeaIn = z.infer<typeof ManualIdeaInSchema>;

// POST /api/posts/:ideaId/schedule (JWT) — assign (or clear) the day an idea
// sits on in the weekly calendar. Powers drag-onto-a-day + the date picker.
export const PostScheduleInSchema = z.object({
  day: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullable(),
});
export type PostScheduleIn = z.infer<typeof PostScheduleInSchema>;

export const ManualIdeaOutSchema = z.object({ idea_id: UuidSchema });
export type ManualIdeaOut = z.infer<typeof ManualIdeaOutSchema>;

// Verifier verdict shape (mirrors outbound.ts verifierMeta) — persisted on the
// post draft so the review surface can show how it was graded.
export const PostVerifierMetaSchema = z.object({
  pass: z.boolean(),
  scores: z.object({
    voice: z.number(),
    grounding: z.number(),
    relevance: z.number(),
    format: z.number(),
  }),
  reasons: z.array(z.string()).max(8),
  attempts: z.number().int().nonnegative(),
  judgeOk: z.boolean().optional(),
  judgeProvider: z.enum(["jev", "legacy", "mixed", "none"]).optional(),
});
export type PostVerifierMeta = z.infer<typeof PostVerifierMetaSchema>;

// POST /api/post-drafts (HMAC) — the post-drafter worker pushes one generated
// post for an approved idea. The route inserts noelle.post_drafts and advances
// the idea to 'drafted'.
export const PostDraftCreateSchema = z.object({
  ideaId: z.string().uuid(),
  platform: PostPlatformSchema,
