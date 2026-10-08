import type { Sql } from "postgres";

// noelle.ideation_requests (0050) — the on-demand trigger queue the dashboard
// "Generate ideas" button fills and the ideation worker drains.

export interface IdeationRequest {
  id: string;
  orgId: string;
  agentInstanceId: string;
  /** 'single'/'batch' generate new idea cards; 'polish' refines one existing
   *  idea in place (idea_id set). See 0061_ideation_polish.sql. */
  mode: "single" | "batch" | "polish";
  count: number | null;
  topics: string[];
  weekStart: string | null;
  batchId: string | null;
  /** The idea to refine — only set for mode='polish'. */
  ideaId: string | null;
  /** Platforms the produced ideas fan out into (e.g. ["linkedin","x"]). null ⇒
   *  the worker default ([its own platform]). Set by /api/posts/ideate per lane. */
  targetPlatforms: string[] | null;
}

/**
 * Atomically claim the oldest N pending ideation requests FOR ONE INSTANCE,
 * flipping them to 'running' (FOR UPDATE SKIP LOCKED so concurrent workers never
 * grab the same row). Returns the claimed requests, oldest-first.
 */
export async function claimIdeationRequests(
  sql: Sql,
  args: { agentInstanceId: string; batch: number },
): Promise<IdeationRequest[]> {
  const rows = await sql<
    {
      id: string;
      org_id: string;
      agent_instance_id: string;
      mode: "single" | "batch" | "polish";
      count: number | null;
      topics: unknown;
      week_start: string | null;
      batch_id: string | null;
      idea_id: string | null;
      target_platforms: string[] | null;
    }[]
  >`
    update noelle.ideation_requests
    set status = 'running', claimed_at = now()
    where id in (
      select id from noelle.ideation_requests
      where status = 'pending'
        and agent_instance_id = ${args.agentInstanceId}
      order by created_at asc
      for update skip locked
      limit ${args.batch}
    )
    returning id, org_id, agent_instance_id, mode, count, topics, week_start, batch_id, idea_id, target_platforms
  `;
  return rows.map((r) => ({
    id: r.id,
    orgId: r.org_id,
    agentInstanceId: r.agent_instance_id,
    mode: r.mode,
    count: r.count,
    topics: Array.isArray(r.topics) ? (r.topics as string[]) : [],
    weekStart: r.week_start,
    batchId: r.batch_id,
    ideaId: r.idea_id,
    targetPlatforms: Array.isArray(r.target_platforms) ? r.target_platforms : null,
  }));
}

export async function finishIdeationRequest(
  sql: Sql,
  args: { id: string; status: "done" | "error"; errorMessage?: string },
): Promise<void> {
  await sql`
    update noelle.ideation_requests
    set status = ${args.status},
        error_message = ${args.errorMessage ?? null},
        finished_at = now()
    where id = ${args.id}
  `;
}
