import type { Sql } from "postgres";
import type { ActiveInstance } from "./activation.js";
import { readSourceCount } from "@noelle/runtime/source-values";
import { withVideoDb, withVideoOwner } from "./video-owner-db.js";
export { upsertTeardown, type ClipForTeardown } from "@noelle/runtime/video-teardown-db";
export { claimClipsForTeardown, completeTeardownClaim, markTeardownDispatched, markTeardownClaimOutcome,
  type TeardownFailureReason } from "@noelle/runtime/video-teardown-claims-db";
export { listVideoGenerationHolds } from "@noelle/runtime/video-generation-holds-db";

/** Active video_intern instances (the teardown + distiller workers process these). */
export async function listActiveVideoInternInstances(sql: Sql): Promise<ActiveInstance[]> {
  const rows = await withVideoDb(sql, tx => tx<ActiveInstance[]>`
    select id, org_id, status, objective, video_feeder_config, budget_cap_cents
    from noelle.agent_instances
    where role = 'video_intern' and status = 'active'
    order by created_at asc
  `);
  return [...rows];
}

/** Completed receipt count only; cloud-call admission is reserved by the shared claim transaction. */
export async function countTeardownsToday(sql: Sql, instanceId: string, orgId: string): Promise<number> {
  return withVideoOwner(sql, instanceId, orgId, async tx => {
    const rows = await tx<{ n: string }[]>`select count(*)::text as n from noelle.video_teardowns t
      join noelle.video_clips c on c.id=t.clip_id and c.org_id=t.org_id
        and c.agent_instance_id=t.agent_instance_id and c.platform=t.platform
      where t.agent_instance_id=${instanceId} and t.org_id=${orgId} and t.generated_at >= date_trunc('day',now())`;
    return readSourceCount(rows[0]?.n) ?? 0;
  }, 0);
}
