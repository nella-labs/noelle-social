import type { Sql } from "postgres";

/** The instance shape the worker loop carries (minimal — Nova's harvester only
 *  needs identity + the feeder config). */
export interface ActiveInstance {
  id: string;
  org_id: string;
  status: "active" | "paused" | "provisioning_alpha";
  objective: string | null;
  /** agent_instances.video_feeder_config jsonb (NULL = feeder OFF). */
  video_feeder_config: unknown | null;
  budget_cap_cents: number | null;
}

/**
 * Pending-run selector — mirrors the LinkedIn account feeder. Returns the
 * video_intern instances whose harvest was requested and hasn't completed yet.
 * Decoupled from active/paused: a harvest runs on demand even while paused.
 */
export async function listInstancesWithPendingHarvest(sql: Sql): Promise<ActiveInstance[]> {
  const rows = await sql<ActiveInstance[]>`
    select id, org_id, status, objective, video_feeder_config, budget_cap_cents
    from noelle.agent_instances
    where role = 'video_intern'
      and video_feeder_run_requested_at is not null
      and (video_feeder_last_run_at is null
           or video_feeder_run_requested_at > video_feeder_last_run_at)
    order by video_feeder_run_requested_at asc
  `;
  return [...rows];
}

/** Stamp the run as complete so the selector won't re-pick it (called in finally). */
export async function markHarvestRunComplete(sql: Sql, instanceId: string): Promise<void> {
  await sql`update noelle.agent_instances set video_feeder_last_run_at = now() where id = ${instanceId}`;
}
