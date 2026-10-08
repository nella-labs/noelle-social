import type { Sql } from "postgres";
import type { ActiveInstance } from "./activation.js";
import type { VideoIdeaIn } from "@noelle/contracts";

export interface PendingIdeationInstance extends ActiveInstance {
  video_ideation_request: unknown | null;
}

/** Selector: instances with a pending ideation request (flag-flip pattern). */
export async function listInstancesWithPendingIdeation(sql: Sql): Promise<PendingIdeationInstance[]> {
  const rows = await sql<PendingIdeationInstance[]>`
    select id, org_id, status, objective, video_feeder_config, budget_cap_cents, video_ideation_request
    from noelle.agent_instances
    where role = 'video_intern'
      and video_ideation_request is not null
      and (video_ideation_last_run_at is null
           or (video_ideation_request->>'requestedAt') is null
           or (video_ideation_request->>'requestedAt')::timestamptz > video_ideation_last_run_at)
    order by id asc`;
  return [...rows];
}

export async function markIdeationComplete(sql: Sql, instanceId: string): Promise<void> {
  await sql`update noelle.agent_instances set video_ideation_last_run_at = now() where id = ${instanceId}`;
}

export async function insertVideoIdeas(
  sql: Sql,
  args: {
    orgId: string;
    instanceId: string;
    platform: string;
    ideas: VideoIdeaIn[];
    batchId: string | null;
    sourceEngine: string;
    model: string;
  },
): Promise<number> {
  if (args.ideas.length === 0) return 0;
  const values = args.ideas.map((i) => ({
    org_id: args.orgId,
    agent_instance_id: args.instanceId,
    platform: args.platform,
    hook: i.hook,
    concept: i.concept ?? null,
    angle: i.angle ?? null,
    pillar: i.pillar ?? null,
    inspiration_clip_ids: i.inspirationClipIds ?? [],
    suggested_day: i.suggestedDay ?? null,
    batch_id: args.batchId,
    status: "proposed",
    source_engine: args.sourceEngine,
    model: args.model,
  }));
  const rows = await sql<{ id: string }[]>`
    insert into noelle.video_ideas ${sql(
      values,
      "org_id", "agent_instance_id", "platform", "hook", "concept", "angle", "pillar",
      "inspiration_clip_ids", "suggested_day", "batch_id", "status", "source_engine", "model",
    )} returning id`;
  return rows.length;
}

export interface ClaimedIdea {
  id: string;
  org_id: string;
  platform: string;
  hook: string;
  concept: string | null;
  inspiration_clip_ids: string[];
}

/** Claim approved ideas → 'drafting' so the scripter owns them (skip-locked). */
export async function claimApprovedIdeas(sql: Sql, instanceId: string, limit: number): Promise<ClaimedIdea[]> {
  const rows = await sql<ClaimedIdea[]>`
    update noelle.video_ideas set status = 'drafting', updated_at = now()
    where id in (
      select id from noelle.video_ideas
      where agent_instance_id = ${instanceId} and status = 'approved'
      order by created_at asc limit ${limit}
      for update skip locked
    )
    returning id, org_id, platform, hook, concept, inspiration_clip_ids`;
  return [...rows];
}

/**
 * Persist the clips a script was ACTUALLY built from (semantic exemplars), so the
 * draft's "Inspired by / modeled on these reels" strip in the studio reflects the
 * real provenance rather than the ideation-time guesses. No-op on an empty list.
 */
export async function setIdeaInspirationClips(sql: Sql, ideaId: string, clipIds: string[]): Promise<void> {
  if (clipIds.length === 0) return;
  await sql`update noelle.video_ideas set inspiration_clip_ids = ${clipIds}, updated_at = now() where id = ${ideaId}`;
}

export async function markIdeaDrafted(sql: Sql, ideaId: string): Promise<void> {
  await sql`update noelle.video_ideas set status = 'drafted', updated_at = now() where id = ${ideaId}`;
}

/** Put a claimed idea back to 'approved' (scripter failed → retry next tick). */
export async function revertIdeaToApproved(sql: Sql, ideaId: string): Promise<void> {
  await sql`update noelle.video_ideas set status = 'approved', updated_at = now() where id = ${ideaId}`;
}
