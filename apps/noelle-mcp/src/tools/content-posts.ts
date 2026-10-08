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
      ? ""
      : `\n\nReviewer/verifier metadata:\n\`\`\`json\n${JSON.stringify(draft.verifier_meta, null, 2)}\n\`\`\``;
  return `#### ${draft.platform} · ${draft.status}/${draft.stage} · ${draft.id}\n\n${mdFields({
    request_id: draft.generation_request_id,
    created_at: draft.created_at,
    updated_at: draft.updated_at,
    chars: draft.char_count,
    source_engine: draft.source_engine,
    model: draft.model,
    reviewer_result: reviewerSummary(draft),
  })}\n\n\`\`\`text\n${body}\n\`\`\`${meta}`;
}

function generationStatus(
  request: GenerationRequest,
  drafts: PostDraftRow[],
  timedOut: boolean,
): string {
  if (request.requestStatus === "drafted" || request.requestStatus === "needs_review") {
    const expectedDrafts = drafts.filter((draft) =>
      request.expectedPlatforms.includes(draft.platform),
    );
    if (!hasEveryExpectedPlatform(expectedDrafts, request.expectedPlatforms))
      return "drafts_missing";
    if (expectedDrafts.some((draft) => reviewVerdict(draft) === "failed"))
      return "needs_review";
    if (
      request.reviewRequired &&
      expectedDrafts.some((draft) => reviewVerdict(draft) === "incomplete")
    )
      return "review_pending";
    return request.requestStatus;
  }
  if (request.requestStatus === "review_pending") return "review_pending";
  if (timedOut) return "timeout";
  if (request.waitSeconds > 0) return "pending";
  return request.requestStatus;
}

export function renderGenerationResult(
  request: GenerationRequest,
  drafts: PostDraftRow[],
  timedOut: boolean,
): ToolResult {
  const requestDrafts = drafts.filter((draft) =>
    request.expectedPlatforms.includes(draft.platform),
  );
  const latest = latestPerPlatform(requestDrafts);
  const missing = missingPlatforms(latest, request.expectedPlatforms);
  const status = generationStatus(request, requestDrafts, timedOut);
  const progress = mdFields({
    idea_id: request.idea.id,
    request_id: request.requestId,
    status,
    journal_status: request.requestStatus,
    wait_timed_out: timedOut || null,
    idea_status: request.idea.status,
    requested_at: request.requestedAt,
    requested_platforms: request.requestedPlatforms?.join(", ") ?? "all target platforms",
    expected_platforms: request.expectedPlatforms.join(", "),
    review_required: request.reviewRequired,
    source: request.source,
    request_drafts_found: requestDrafts.length,
    waiting_for:
      missing.join(", ") ||
      (status === "review_pending"
        ? "reviewer/verifier results"
        : status === "queued" || status === "drafting" || status === "pending"
          ? "worker finalization"
          : null),
  });
  const bodies =
    requestDrafts.length > 0
      ? requestDrafts.map(renderDraftBody).join("\n\n")
      : "_No worker-created drafts for this request yet._";
  const note =
    status === "drafted"
      ? request.reviewRequired
        ? "New worker-created draft(s) passed the existing reviewer/verifier for every expected platform."
        : "Worker-created drafts exist for every expected platform. Automatic review was not required."
      : status === "needs_review"
        ? requestDrafts.some((draft) => reviewVerdict(draft) === "failed")
          ? "At least one returned draft has a failed review result."
          : "The request journal requires review; no failed reviewer result is available in the returned drafts."
        : status === "review_pending"
          ? "Returned drafts are awaiting complete reviewer/verifier results."
          : "This result is not claiming the draft is done. Read the journal status and returned draft evidence below.";

  return text(`## Post generation ${status}\n\n${note}\n\n${progress}\n\n${bodies}`);
}

function toGenerationRequest(
  idea: PostIdeaRow,
  row: GenerationRequestRow,
  waitSeconds: number,
): GenerationRequest {
  return {
    idea,
    requestId: row.id,
    requestStatus: row.status,
    requestedAt: row.created_at,
    requestedPlatforms: null,
    expectedPlatforms: row.platforms,
    reviewRequired: row.review_required,
    source: row.source,
    waitSeconds,
  };
}

export async function generatePostWithProgress(
  args: Record<string, unknown>,
  ctx: NoelleContext,
  org: OrgRef,
  ideaId: string,
  guidance: string | undefined,
): Promise<ToolResult> {
  const waitSeconds = postWaitSeconds(args);
  const requestedPlatforms = requestedPostPlatforms(args);
  const admitted = await requestContentPostGeneration(ctx.sql, { orgId: org.orgId, ideaId }, {
    platforms: requestedPlatforms, guidance, journal: { source: "mcp", reviewRequired: true },
  });
  if (!admitted.request) throw new NoelleError("Post generation request returned no receipt.");
  const request = toGenerationRequest(admitted.idea, admitted.request, waitSeconds);
  if (!admitted.reused) request.requestedPlatforms = requestedPlatforms;
  const { request: currentRequest, drafts, timedOut } = await pollGenerationDrafts(ctx, request);
  return renderGenerationResult(currentRequest, drafts, timedOut);
}

export async function getPostWithFullDrafts(
  ctx: NoelleContext,
  org: OrgRef,
  ideaId: string,
  args: Record<string, unknown> = {},
): Promise<ToolResult> {
  const idea = await loadIdea(ctx, org, ideaId);
  const requestId = optStr(args, "requestId");
  if (requestId) {
    const row = await loadGenerationRequest(ctx, org, idea, requestId);
    const request = toGenerationRequest(idea, row, postWaitSeconds(args));
    const { request: currentRequest, drafts, timedOut } = await pollGenerationDrafts(ctx, request);
    return renderGenerationResult(currentRequest, drafts, timedOut);
  }

  const drafts = await loadAllDrafts(ctx, org.orgId, ideaId);
  const targetPlatforms = storedTargets(idea);
  const pending =
    Array.isArray(idea.pending_platforms) && idea.pending_platforms.length > 0
      ? idea.pending_platforms
      : [];
  const latest = latestPerPlatform(drafts);
  const progressTable = mdTable(
    ["platform", "latest draft", "status/stage", "reviewer"],
    targetPlatforms.map((platform) => {
      const draft = latest.find((d) => d.platform === platform);
      return [
        platform,
        draft ? draft.id : pending.includes(platform) ? "pending regeneration" : "missing",
        draft ? `${draft.status}/${draft.stage}` : "—",
        draft ? reviewerSummary(draft) : "—",
      ];
    }),
  );
  const header = mdFields({
    id: idea.id,
    status: idea.status,
    active_request_id: idea.generation_request_id,
    generation_review_required: idea.generation_review_required === true ? true : null,
    platform: idea.platform,
    targets: targetPlatforms.join(", "),
    pending_regeneration: pending.join(", ") || null,
    hook: idea.hook,
    thesis: idea.thesis,
    angle: idea.angle,
    pillar: idea.pillar,
    suggested_day: idea.suggested_day,
    batch_id: idea.batch_id,
    source_engine: idea.source_engine,
    model: idea.model,
    created_at: idea.created_at,
    updated_at: idea.updated_at,
  });
  const body =
    drafts.length > 0
      ? drafts.map(renderDraftBody).join("\n\n")
      : "_No post drafts have been created yet._";
  return text(
    `## Post idea\n\n${header}\n\n### Progress\n\n${progressTable}\n\n### Draft bodies (${drafts.length})\n\n${body}`,
  );
}
