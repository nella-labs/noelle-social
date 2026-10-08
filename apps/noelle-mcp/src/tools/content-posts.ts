import { requestContentPostGeneration, type ContentPostIdeaRecord, type ContentPostGenerationRecord } from "@noelle/runtime";
import { NoelleError, type NoelleContext, type OrgRef } from "../context.js";
import { mdFields, mdTable, text } from "../result.js";
import type { ToolResult } from "../types.js";
import { pollUntil } from "../poll.js";
import { optNum, optStr, optStrArray } from "./_shared.js";

const POST_PLATFORMS = ["linkedin", "x", "reddit"] as const;
type PostPlatform = (typeof POST_PLATFORMS)[number];

export type PostIdeaRow = ContentPostIdeaRecord;
type GenerationRequestRow = ContentPostGenerationRecord;

export interface PostDraftRow {
  id: string;
  platform: string;
  status: string;
  stage: string;
  body: string | null;
  final_body: string | null;
  char_count: number | null;
  hook: string | null;
  source_engine: string | null;
  model: string | null;
  quality_score: string | null;
  quality_passed: boolean | null;
  verifier_meta: unknown;
  generation_request_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface GenerationRequest {
  idea: PostIdeaRow;
  requestId: string;
  requestStatus: string;
  requestedAt: string;
  requestedPlatforms: PostPlatform[] | null;
  expectedPlatforms: string[];
  reviewRequired: boolean;
  source: string;
  waitSeconds: number;
}

export function postWaitSeconds(args: Record<string, unknown>): number {
  const raw = optNum(args, "waitSeconds") ?? 0;
  if (raw < 0) throw new NoelleError("waitSeconds must be 0 or greater.");
  return Math.min(45, Math.floor(raw));
}

export function requestedPostPlatforms(args: Record<string, unknown>): PostPlatform[] | null {
  const values = optStrArray(args, "platforms");
  if (!values || values.length === 0) return null;
  const out: PostPlatform[] = [];
  for (const value of values) {
    if (!POST_PLATFORMS.includes(value as PostPlatform)) {
      throw new NoelleError(`Unsupported post platform "${value}". Use linkedin, x, or reddit.`);
    }
    if (!out.includes(value as PostPlatform)) out.push(value as PostPlatform);
  }
  return out;
}

function storedTargets(idea: Pick<PostIdeaRow, "platform" | "target_platforms">): string[] {
  return Array.isArray(idea.target_platforms) && idea.target_platforms.length > 0
    ? idea.target_platforms
    : [idea.platform];
}

async function loadIdea(ctx: NoelleContext, org: OrgRef, ideaId: string): Promise<PostIdeaRow> {
  const [idea] = await ctx.sql<PostIdeaRow[]>`
    select id, org_id, agent_instance_id, platform, target_platforms, pending_platforms,
      generation_request_id, generation_review_required,
      hook, thesis, angle, pillar, status, source_engine, model,
      suggested_day::text as suggested_day, batch_id, created_at::text as created_at, updated_at::text as updated_at
    from noelle.post_ideas where id = ${ideaId} and org_id = ${org.orgId} limit 1`;
  if (!idea) throw new NoelleError(`Post idea ${ideaId} not found in ${org.name}.`);
  return idea;
}

async function loadGenerationRequest(
  ctx: NoelleContext,
  org: OrgRef,
  idea: PostIdeaRow,
  requestId: string,
): Promise<GenerationRequestRow> {
  const [request] = await ctx.sql<GenerationRequestRow[]>`
    select id, org_id, agent_instance_id, idea_id, platforms, guidance, review_required, source,
      status, created_at::text as created_at, updated_at::text as updated_at, completed_at::text as completed_at
    from noelle.post_generation_requests
    where id = ${requestId} and idea_id = ${idea.id} and org_id = ${org.orgId}
      and agent_instance_id = ${idea.agent_instance_id}
    limit 1`;
  if (!request)
    throw new NoelleError(`Post generation request ${requestId} not found for idea ${idea.id}.`);
  return request;
}

async function loadGenerationDrafts(
  ctx: NoelleContext,
  idea: PostIdeaRow,
  requestId: string,
): Promise<PostDraftRow[]> {
  return ctx.sql<PostDraftRow[]>`
    select id, platform, status, stage, body, final_body, char_count, hook, source_engine, model,
      quality_score, quality_passed, verifier_meta, generation_request_id,
      created_at::text as created_at, updated_at::text as updated_at
    from noelle.post_drafts
    where org_id = ${idea.org_id} and generation_request_id = ${requestId}
      and idea_id = ${idea.id} and agent_instance_id = ${idea.agent_instance_id}
    order by created_at desc`;
}

async function loadAllDrafts(
  ctx: NoelleContext,
  orgId: string,
  ideaId: string,
): Promise<PostDraftRow[]> {
  return ctx.sql<PostDraftRow[]>`
    select id, platform, status, stage, body, final_body, char_count, hook, source_engine, model,
      quality_score, quality_passed, verifier_meta, generation_request_id,
      created_at::text as created_at, updated_at::text as updated_at
    from noelle.post_drafts where idea_id = ${ideaId} and org_id = ${orgId} order by created_at desc`;
}

async function pollGenerationDrafts(
  ctx: NoelleContext,
  request: GenerationRequest,
): Promise<{ request: GenerationRequest; drafts: PostDraftRow[]; timedOut: boolean }> {
  const current = await pollUntil(
    async () => {
      const row = await loadGenerationRequest(
        ctx,
        { orgId: request.idea.org_id, slug: "", name: "" },
        request.idea,
        request.requestId,
      );
      return {
        request: toGenerationRequest(request.idea, row, request.waitSeconds),
        drafts: await loadGenerationDrafts(ctx, request.idea, request.requestId),
      };
    },
    (value) => requestHasReviewResult(value.drafts, value.request),
    request.waitSeconds,
  );
  return {
    ...current,
    timedOut: request.waitSeconds > 0 && !requestHasReviewResult(current.drafts, current.request),
  };
}

export function hasEveryExpectedPlatform(drafts: PostDraftRow[], platforms: string[]): boolean {
  const seen = new Set(drafts.map((d) => d.platform));
  return platforms.length > 0 && platforms.every((platform) => seen.has(platform));
}

function requestHasReviewResult(drafts: PostDraftRow[], request: GenerationRequest): boolean {
  const status = generationStatus(request, drafts, false);
  return status === "drafted" || status === "needs_review";
}

function missingPlatforms(drafts: PostDraftRow[], platforms: string[]): string[] {
  const seen = new Set(drafts.map((d) => d.platform));
  return platforms.filter((platform) => !seen.has(platform));
}

function latestPerPlatform(drafts: PostDraftRow[]): PostDraftRow[] {
  const seen = new Set<string>();
  const latest: PostDraftRow[] = [];
  for (const draft of drafts) {
    if (seen.has(draft.platform)) continue;
    seen.add(draft.platform);
    latest.push(draft);
  }
  return latest;
}

function reviewVerdict(draft: PostDraftRow): "passed" | "failed" | "incomplete" {
  const meta = draft.verifier_meta;
  const pass = meta !== null && typeof meta === "object" && !Array.isArray(meta)
    ? (meta as Record<string, unknown>).pass
    : undefined;
  if (draft.quality_passed === false || pass === false) return "failed";
  if (draft.quality_passed === true && pass === true) return "passed";
  return "incomplete";
}

function reviewerSummary(draft: PostDraftRow): string {
  if (draft.verifier_meta != null || draft.quality_score != null || draft.quality_passed != null) {
    const result = reviewVerdict(draft);
    const verdict = result === "incomplete" ? "review pending" : result;
    return `${verdict}${draft.quality_score != null ? `, score ${draft.quality_score}` : ""}`;
  }
  return "review pending from worker";
}

function renderDraftBody(draft: PostDraftRow): string {
  const body = draft.final_body ?? draft.body ?? "";
  const meta =
    draft.verifier_meta == null
