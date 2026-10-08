import { NoelleError, type NoelleContext, type OrgRef } from "../context.js";
import { pollUntil } from "../poll.js";
import { text } from "../result.js";
import type { ToolResult } from "../types.js";
import { postWaitSeconds } from "./content-posts.js";

interface IdeationRequestRow {
  id: string;
  agent_instance_id: string;
  batch_id: string | null;
  idea_id: string | null;
  status: string;
  count: number | null;
  topics: string[];
  target_platforms: string[];
  error_message: string | null;
  created_at: string;
  finished_at: string | null;
}

/** Read the worker's exact batch, including errors and source references. */
export async function getIdeationRequest(
  ctx: NoelleContext,
  org: OrgRef,
  requestId: string,
  args: Record<string, unknown> = {},
): Promise<ToolResult> {
  const request = await pollUntil(async () => {
    const [row] = await ctx.sql<IdeationRequestRow[]>`
      select id, agent_instance_id, batch_id, idea_id, status, count, topics,
        target_platforms, error_message, created_at::text, finished_at::text
      from noelle.ideation_requests
      where id = ${requestId} and org_id = ${org.orgId}
      limit 1`;
    if (!row) throw new NoelleError(`Ideation request ${requestId} not found in ${org.name}.`);
    return row;
  }, (row) => row.status === "done" || row.status === "error", postWaitSeconds(args));

  const ideas = request.batch_id || request.idea_id
    ? await ctx.sql`
        select id, platform, target_platforms, status, hook, thesis, angle, pillar,
          inspiration_refs, source_engine, model, batch_id, created_at::text
        from noelle.post_ideas
        where org_id = ${org.orgId} and agent_instance_id = ${request.agent_instance_id}
          and ((${request.batch_id}::uuid is not null and batch_id = ${request.batch_id})
            or (${request.batch_id}::uuid is null and id = ${request.idea_id}))
        order by created_at, id`
    : [];

  return text(JSON.stringify({
    requestId: request.id,
    status: request.status,
    requestedCount: request.count,
    topics: request.topics,
    targetPlatforms: request.target_platforms,
    createdAt: request.created_at,
    finishedAt: request.finished_at,
    error: request.error_message,
    ideas,
    next: request.status === "done"
      ? "Use the returned idea IDs with noelle_generate_post when drafts are requested."
      : request.status === "error"
        ? "Inspect this worker error. Do not substitute chat-written ideas for Noelle's results."
        : "Poll this same request ID; do not queue a duplicate or substitute chat-written ideas.",
  }, null, 2));
}
