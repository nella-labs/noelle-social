"use server";

/**
 * Server Actions for the Posts lane (Ideas board). All POST to
 * api.trynoelle.com via noelleFetch (JWT); the Hono routes do the
 * org-membership check, so no assertOrgMember here. On success we revalidate
 * the Posts board so the next render reflects the new state.
 *
 * Wire shapes per @noelle/contracts (posts.ts):
 *   POST /api/posts/ideate             body { mode, count?, topics?, weekStart? }
 *   POST /api/posts/:ideaId/generate   (empty)  → { idea_id, status }
 *   POST /api/posts/:id/dismiss        body { target }
 */

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { noelleFetch, NoelleApiError } from "@/lib/api";
import { withRateLimit } from "@/lib/with-rate-limit";
import { getPostThread } from "@/lib/posts-queries";
import { getOrgBySlug } from "@/lib/queries";
import { getInstanceIdForRole } from "@/lib/schedule-queries";
import { platformToRole } from "@/lib/agent-content-config";
import {
  UuidSchema,
  IdeationTriggerInSchema,
  IdeationTriggerOutSchema,
  ManualIdeaInSchema,
  ManualIdeaOutSchema,
  PostGenerateOutSchema,
  PostActionOutSchema,
  PostReplaceOutSchema,
  PostMarkReadyInSchema,
  PostChatInSchema,
  PostChatOutSchema,
  PostPolishOutSchema,
  ContentMediaCreatedSchema,
  type IdeationTriggerIn,
  type ManualIdeaIn,
  type PostMarkReadyIn,
  type PostChatIn,
} from "@/lib/contracts";

type ActionError = { code: string; message: string; status: number; retry_after_ms?: number };

function toError(e: unknown): { ok: false; error: ActionError } {
  if (e instanceof NoelleApiError) {
    return { ok: false, error: { code: e.code, message: e.message, status: e.status, retry_after_ms: e.retryAfterMs } };
  }
  throw e;
}

async function creationScope(input: Pick<IdeateInput, "orgSlug" | "platform" | "instanceId">) {
  const org = await getOrgBySlug(input.orgSlug);
  if (!org) return { ok: false as const, error: { code: "not_found", message: "Organization not found.", status: 404 } };
  const role = platformToRole(input.platform ?? "linkedin")!;
  const instanceId = await getInstanceIdForRole(org.id, role);
  if (!instanceId || (input.instanceId && input.instanceId.toLowerCase() !== instanceId.toLowerCase())) {
    return { ok: false as const, error: { code: "no_active_instance", message: "Content owner not found for this lane.", status: 404 } };
  }
  return { ok: true as const, orgId: org.id, agentInstanceId: instanceId };
}

const IdeateInput = z.object({
  orgSlug: z.string().min(1),
  instanceId: UuidSchema.optional(),
  mode: z.enum(["single", "batch"]).default("single"),
  // How many ideas to generate in single mode (1-10). Batch is always 7.
  count: z.number().int().min(1).max(10).optional(),
  topics: z.array(z.string().min(1)).max(20).optional(),
  weekStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  // The lane the operator triggered from. x → Vega ideates X-only ideas;
  // linkedin → Lyra, linkedin-only; absent (All) → Lyra, linkedin+x fan-out.
  platform: z.enum(["linkedin", "x"]).optional(),
});
export type IdeateInput = z.infer<typeof IdeateInput>;

export const triggerIdeation = withRateLimit(
  "posts.ideate",
  { capacity: 20, refillPerSecond: 0.5, cost: 4 },
  async (input: IdeateInput) => {
    const parsed = IdeateInput.parse(input);
    const scope = await creationScope(parsed);
    if (!scope.ok) return scope;
    const wire: IdeationTriggerIn = {
      orgId: scope.orgId,
      agentInstanceId: scope.agentInstanceId,
      mode: parsed.mode,
      count: parsed.mode === "single" ? parsed.count : undefined,
      topics: parsed.topics,
      weekStart: parsed.weekStart,
      platform: parsed.platform,
    };
    IdeationTriggerInSchema.parse(wire);
    try {
      const res = await noelleFetch("/api/posts/ideate", { method: "POST", body: wire });
      const out = IdeationTriggerOutSchema.parse(res);
      revalidatePath(`/app/${parsed.orgSlug}/content`);
      return { ok: true as const, mode: out.mode, batchId: out.batch_id };
    } catch (e) {
      return toError(e);
    }
  },
);

const ManualIdeaInput = z.object({
  orgSlug: z.string().min(1),
  instanceId: UuidSchema.optional(),
  hook: z.string().min(1).max(3000),
  thesis: z.string().max(1200).optional(),
  angle: z.string().max(60).optional(),
  pillar: z.string().max(120).optional(),
  suggestedDay: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  targetPlatforms: z.array(z.enum(["linkedin", "x", "reddit"])).min(1).max(3).optional(),
  // The lane the operator authored from → the idea's home/owning platform.
  platform: z.enum(["linkedin", "x"]).optional(),
});
export type ManualIdeaInput = z.infer<typeof ManualIdeaInput>;

export const addManualIdea = withRateLimit(
  "posts.manual",
  { capacity: 30, refillPerSecond: 0.5, cost: 2 },
  async (input: ManualIdeaInput) => {
    const parsed = ManualIdeaInput.parse(input);
    const scope = await creationScope(parsed);
    if (!scope.ok) return scope;
    const wire: ManualIdeaIn = {
      orgId: scope.orgId,
      agentInstanceId: scope.agentInstanceId,
      hook: parsed.hook.trim(),
      thesis: parsed.thesis?.trim() || undefined,
      angle: parsed.angle?.trim() || undefined,
      pillar: parsed.pillar?.trim() || undefined,
      suggestedDay: parsed.suggestedDay,
      targetPlatforms: parsed.targetPlatforms,
      platform: parsed.platform,
    };
    ManualIdeaInSchema.parse(wire);
    try {
      const res = await noelleFetch("/api/posts/manual", { method: "POST", body: wire });
      const out = ManualIdeaOutSchema.parse(res);
      revalidatePath(`/app/${parsed.orgSlug}/content`);
      return { ok: true as const, ideaId: out.idea_id };
    } catch (e) {
      return toError(e);
    }
  },
);

const ScheduleInput = z.object({
  orgSlug: z.string().min(1),
  ideaId: z.string().uuid(),
  day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
});
export type ScheduleInput = z.infer<typeof ScheduleInput>;

// Assign (or clear) the day an idea sits on — drag-onto-a-day + the date picker.
export const schedulePostIdea = withRateLimit(
  "posts.schedule",
  { capacity: 120, refillPerSecond: 2, cost: 1 },
  async (input: ScheduleInput) => {
    const parsed = ScheduleInput.parse(input);
    try {
      await noelleFetch(`/api/posts/${encodeURIComponent(parsed.ideaId)}/schedule`, {
        method: "POST",
        body: { day: parsed.day },
      });
      revalidatePath(`/app/${parsed.orgSlug}/content`);
      return { ok: true as const };
    } catch (e) {
      return toError(e);
    }
  },
);

const GenerateInput = z.object({
  orgSlug: z.string().min(1),
  ideaId: z.string().uuid(),
  // Scope a regenerate to a subset (per-platform "+ Version"). Absent ⇒ the
  // drafter (re)drafts every target platform.
  platforms: z.array(z.enum(["linkedin", "x", "reddit"])).min(1).max(3).optional(),
  // A one-off refine steer for this regen ("make it punchier", "drop the stat").
  guidance: z.string().max(2000).optional(),
});
export type GenerateInput = z.infer<typeof GenerateInput>;

export const generatePost = withRateLimit(
  "posts.generate",
  { capacity: 60, refillPerSecond: 1, cost: 1 },
  async (input: GenerateInput) => {
    const parsed = GenerateInput.parse(input);
    try {
      const res = await noelleFetch(`/api/posts/${encodeURIComponent(parsed.ideaId)}/generate`, {
        method: "POST",
        body: {
          ...(parsed.platforms ? { platforms: parsed.platforms } : {}),
          ...(parsed.guidance ? { guidance: parsed.guidance } : {}),
        },
      });
      const out = PostGenerateOutSchema.parse(res);
      revalidatePath(`/app/${parsed.orgSlug}/content`);
      revalidatePath(`/app/${parsed.orgSlug}/content/${parsed.ideaId}`);
      return { ok: true as const, status: out.status };
    } catch (e) {
      return toError(e);
    }
  },
);

// Ask the agent to sharpen ONE idea's hook/thesis in place. Async: enqueues a
// polish request the ideation worker drains; the refined idea appears on the
// next refresh (AutoRefresh, 30s).
const PolishInput = z.object({
  orgSlug: z.string().min(1),
  ideaId: z.string().uuid(),
});
export type PolishInput = z.infer<typeof PolishInput>;

export const polishIdea = withRateLimit(
  "posts.polish",
  { capacity: 60, refillPerSecond: 1, cost: 1 },
  async (input: PolishInput) => {
    const parsed = PolishInput.parse(input);
    try {
      const res = await noelleFetch(`/api/posts/${encodeURIComponent(parsed.ideaId)}/polish`, {
        method: "POST",
        body: {},
      });
      const out = PostPolishOutSchema.parse(res);
      revalidatePath(`/app/${parsed.orgSlug}/content`);
      revalidatePath(`/app/${parsed.orgSlug}/content/${parsed.ideaId}`);
      return { ok: true as const, queued: out.queued };
    } catch (e) {
      return toError(e);
    }
  },
);

const MarkReadyInput = z.object({
  orgSlug: z.string().min(1),
  draftId: z.string().uuid(),
  /** The operator's edited body, when they changed it inline. */
  editedBody: z.string().max(8000).optional(),
});
export type MarkReadyInput = z.infer<typeof MarkReadyInput>;

export const markReadyPost = withRateLimit(
  "posts.mark_ready",
  { capacity: 60, refillPerSecond: 1, cost: 1 },
  async (input: MarkReadyInput) => {
    const parsed = MarkReadyInput.parse(input);
    const wire: PostMarkReadyIn = { editedBody: parsed.editedBody };
    PostMarkReadyInSchema.parse(wire);
    try {
      const res = await noelleFetch(`/api/posts/${encodeURIComponent(parsed.draftId)}/mark-ready`, {
        method: "POST",
        body: wire,
      });
      PostActionOutSchema.parse(res);
      revalidatePath(`/app/${parsed.orgSlug}/content`);
      return { ok: true as const };
    } catch (e) {
      return toError(e);
    }
  },
);

const MarkPostedInput = z.object({
  orgSlug: z.string().min(1),
  draftId: z.string().uuid(),
  // Optional URL of the live post the operator just published by hand.
  postedUrl: z.string().url().max(2000).optional(),
});
export type MarkPostedInput = z.infer<typeof MarkPostedInput>;

// Operator posted this variant by hand → archive it off the board (+ store url).
export const markPostedPost = withRateLimit(
  "posts.mark_posted",
  { capacity: 60, refillPerSecond: 1, cost: 1 },
  async (input: MarkPostedInput) => {
    const parsed = MarkPostedInput.parse(input);
    try {
      const res = await noelleFetch(`/api/posts/${encodeURIComponent(parsed.draftId)}/mark-posted`, {
        method: "POST",
        body: parsed.postedUrl ? { postedUrl: parsed.postedUrl } : {},
      });
      PostActionOutSchema.parse(res);
      revalidatePath(`/app/${parsed.orgSlug}/content`);
      return { ok: true as const };
    } catch (e) {
      return toError(e);
    }
  },
);

// Inline edit of one platform variant's rich column fields. Only the keys the
// caller passes are sent (and written server-side); the rest are left untouched.
const PatchInput = z.object({
  orgSlug: z.string().min(1),
  draftId: z.string().uuid(),
  hook: z.string().max(2000).nullable().optional(),
  cta: z.string().max(2000).nullable().optional(),
  notes: z.string().max(8000).nullable().optional(),
  category: z.enum(["building", "studying", "workout", "gtm"]).nullable().optional(),
  stage: z.enum(["draft", "written", "scheduled", "posted"]).optional(),
  body: z.string().max(8000).optional(),
  postedUrl: z.string().url().max(2000).nullable().optional(),
});
export type PatchInput = z.infer<typeof PatchInput>;

export const patchPostDraft = withRateLimit(
  "posts.patch",
  { capacity: 120, refillPerSecond: 2, cost: 1 },
  async (input: PatchInput) => {
    const { orgSlug, draftId, ...rest } = PatchInput.parse(input);
    // Only forward keys that were actually provided.
    const wire = Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined));
    if (Object.keys(wire).length === 0) return { ok: true as const };
    try {
      await noelleFetch(`/api/posts/${encodeURIComponent(draftId)}/patch`, { method: "POST", body: wire });
      revalidatePath(`/app/${orgSlug}/content`);
      return { ok: true as const };
    } catch (e) {
      return toError(e);
    }
  },
);

const ChatInput = z.object({
  orgSlug: z.string().min(1),
  ideaId: z.string().uuid(),
  message: z.string().min(1).max(4000),
  pin: z.boolean().default(false),
});
export type ChatInput = z.infer<typeof ChatInput>;

export const sendPostChat = withRateLimit(
  "posts.chat",
  { capacity: 40, refillPerSecond: 1, cost: 2 },
  async (input: ChatInput) => {
    const parsed = ChatInput.parse(input);
    const wire: PostChatIn = { message: parsed.message, pin: parsed.pin };
    PostChatInSchema.parse(wire);
    try {
      const res = await noelleFetch(`/api/posts/${encodeURIComponent(parsed.ideaId)}/chat`, {
        method: "POST",
        body: wire,
      });
      const out = PostChatOutSchema.parse(res);
      revalidatePath(`/app/${parsed.orgSlug}/content/${parsed.ideaId}`);
      revalidatePath(`/app/${parsed.orgSlug}/content`);
      return { ok: true as const, queued: out.queued, pinned: out.pinned };
    } catch (e) {
      return toError(e);
    }
  },
);

const DismissInput = z.object({
  orgSlug: z.string().min(1),
  id: z.string().uuid(),
  target: z.enum(["idea", "draft"]),
  // "set" (Drafts board) dismisses every version of the draft's (idea, platform)
  // so the card actually disappears; "row" (per-version Dismiss) drops only this
  // one. Only meaningful for target:"draft". Omitted ⇒ server default "row".
  scope: z.enum(["row", "set"]).optional(),
});
export type DismissInput = z.infer<typeof DismissInput>;

export const dismissPost = withRateLimit(
  "posts.dismiss",
  { capacity: 60, refillPerSecond: 1, cost: 1 },
  async (input: DismissInput) => {
    const parsed = DismissInput.parse(input);
    try {
      const res = await noelleFetch(`/api/posts/${encodeURIComponent(parsed.id)}/dismiss`, {
        method: "POST",
        body: { target: parsed.target, ...(parsed.scope ? { scope: parsed.scope } : {}) },
      });
      PostActionOutSchema.parse(res);
      revalidatePath(`/app/${parsed.orgSlug}/content`);
      return { ok: true as const };
    } catch (e) {
      return toError(e);
    }
  },
);

const ReplaceInput = z.object({
  orgSlug: z.string().min(1),
  ideaId: z.string().uuid(),
});
export type ReplaceInput = z.infer<typeof ReplaceInput>;

// Kill an idea AND queue ONE replacement on the same theme (the review board's
// "kill an idea → another appears"). One call = dismiss + single-idea ideation;
// the fresh proposed idea surfaces on the next refresh.
export const replacePostIdea = withRateLimit(
  "posts.replace",
  { capacity: 40, refillPerSecond: 0.5, cost: 2 },
  async (input: ReplaceInput) => {
