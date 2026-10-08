import type { Sql } from "postgres";
import { withVideoOwner } from "./videoOwnerDb.js";
import { briefSnapshotSql, type ClaimedDraftForBrief } from "./videoRecordingBriefClaimsDb.js";
export { insertRecordingBrief, markBriefDispatched, markBriefClaimOutcome, revertBriefClaim,
  type ClaimedDraftForBrief, type BriefFailureReason, type HeldBriefClaim, type InsertRecordingBriefArgs } from "./videoRecordingBriefClaimsDb.js";

/** Admit at most ten captured sources; queued recovery gets a snapshot only here. */
export async function claimReadyDraftsForBrief(parent: Sql, instanceId: string, limit: number, orgId: string,
  provenance?: { sourceEngine: string; model: string }): Promise<ClaimedDraftForBrief[]> {
  if (!Number.isSafeInteger(limit) || limit < 1) throw new RangeError("Recording brief limit must be a positive safe integer");
  return withVideoOwner(parent, instanceId, orgId, async sql => {
    await sql`select pg_advisory_xact_lock(hashtextextended(${'video-brief-admission:' + instanceId.toLowerCase()},0))`;
    const rows = await sql<ClaimedDraftForBrief[]>`with candidates as materialized (
      select d.id as draft_id,d.org_id,d.agent_instance_id,d.idea_id,d.platform,
        coalesce(nullif(d.final_script,''),d.script) as script,d.script as generated_script,d.final_script,
        d.updated_at::text as draft_updated_at,i.updated_at::text as idea_updated_at,d.structure,i.hook,i.concept,
        coalesce(d.marked_ready_at,d.created_at) as source_order_at,${briefSnapshotSql(sql)} as source_snapshot
      from noelle.video_drafts d join noelle.video_ideas i on i.id=d.idea_id and i.org_id=d.org_id
        and i.agent_instance_id=d.agent_instance_id and i.platform=d.platform
      left join noelle.video_recording_briefs b on b.draft_id=d.id
      where d.agent_instance_id=${instanceId} and d.org_id=${orgId} and d.status='ready'
        and (b.id is null or (b.org_id=d.org_id and b.agent_instance_id=d.agent_instance_id and b.idea_id=d.idea_id
          and b.platform=d.platform and b.status in ('queued','released')))
        and not exists(select 1 from noelle.video_recording_brief_attempts a where a.draft_id=d.id
          and a.status not in ('superseded','released') and not (a.status='queued' and a.brief_id=b.id
            and a.org_id=d.org_id and a.agent_instance_id=d.agent_instance_id and a.idea_id=d.idea_id
            and a.platform=d.platform and a.admitted_at is null and a.dispatched_at is null))
      order by coalesce(d.marked_ready_at,d.created_at),d.id limit ${Math.min(limit, 10)} for update of d,i skip locked
    ), projected as (
      insert into noelle.video_recording_briefs(org_id,agent_instance_id,draft_id,idea_id,platform,status,source_engine,model)
      select org_id,agent_instance_id,draft_id,idea_id,platform,'building',${provenance?.sourceEngine ?? null},${provenance?.model ?? null} from candidates
      on conflict(draft_id) do update set status='building',brief='{}'::jsonb,brief_md='',runtime_target=null,forge_followups=0,
        source_engine=excluded.source_engine,model=excluded.model
      where video_recording_briefs.org_id=excluded.org_id and video_recording_briefs.agent_instance_id=excluded.agent_instance_id
        and video_recording_briefs.idea_id=excluded.idea_id and video_recording_briefs.platform=excluded.platform
        and video_recording_briefs.status in ('queued','released') returning id,draft_id
    ), admitted as (
      insert into noelle.video_recording_brief_attempts
        (org_id,agent_instance_id,draft_id,idea_id,brief_id,platform,status,reason,source_snapshot,configured_engine,configured_model,admitted_at)
      select c.org_id,c.agent_instance_id,c.draft_id,c.idea_id,b.id,c.platform,'building','generation_in_progress',
        c.source_snapshot,${provenance?.sourceEngine ?? null},${provenance?.model ?? null},now()
      from candidates c join projected b using(draft_id)
      on conflict(draft_id) where status not in ('superseded','released') do update set status='building',
        reason='generation_in_progress',source_snapshot=excluded.source_snapshot,admitted_at=now(),
        configured_engine=excluded.configured_engine,configured_model=excluded.configured_model
      where video_recording_brief_attempts.status='queued' and video_recording_brief_attempts.admitted_at is null
        and video_recording_brief_attempts.dispatched_at is null and video_recording_brief_attempts.brief_id=excluded.brief_id
        and video_recording_brief_attempts.org_id=excluded.org_id and video_recording_brief_attempts.agent_instance_id=excluded.agent_instance_id
        and video_recording_brief_attempts.idea_id=excluded.idea_id and video_recording_brief_attempts.platform=excluded.platform
      returning id as claim_id,brief_id,draft_id
    ) select a.claim_id,a.brief_id,c.draft_id,c.org_id,c.agent_instance_id,c.idea_id,c.platform,c.script,
        c.generated_script,c.final_script,c.draft_updated_at,c.idea_updated_at,c.structure,c.hook,c.concept,c.source_snapshot
      from admitted a join candidates c using(draft_id)
      order by c.source_order_at,c.draft_id`;
    return [...rows];
  }, []);
}

/** Explicit recovery retains the exact predecessor and queues work without dispatch. */
export function retryRecordingBrief(parent: Sql, args: { orgId: string; instanceId: string; draftId: string;
  expectedClaimUUID: string; operatorId: string }): Promise<string | null> {
  return withVideoOwner(parent, args.instanceId, args.orgId, async sql => {
    const sources = await sql<Array<{ idea_id: string; platform: string }>>`select d.idea_id,d.platform
      from noelle.video_drafts d
      join noelle.video_ideas i on i.id=d.idea_id and i.org_id=d.org_id and i.agent_instance_id=d.agent_instance_id and i.platform=d.platform
      where d.org_id=${args.orgId} and d.agent_instance_id=${args.instanceId} and d.id=${args.draftId}
        and d.status='ready' for update of d,i`;
    if (sources.length !== 1) return null;
    const source = sources[0]!;
    const briefs = await sql<Array<{ id: string; idea_id: string; platform: string }>>`select id,idea_id,platform
      from noelle.video_recording_briefs where org_id=${args.orgId} and agent_instance_id=${args.instanceId}
        and draft_id=${args.draftId} and idea_id=${source.idea_id} and platform=${source.platform}
        and status in ('building','dispatched','unknown','failed') for update`;
    if (briefs.length !== 1) return null;
    const brief = briefs[0]!;
    // A late legacy writer has no measured dispatch/snapshot; adoption requires its exact UUID.
    if (brief.id === args.expectedClaimUUID.toLowerCase()) await sql`insert into noelle.video_recording_brief_attempts
      (id,org_id,agent_instance_id,draft_id,idea_id,brief_id,platform,status,reason,configured_engine,configured_model,created_at)
      select id,org_id,agent_instance_id,draft_id,idea_id,id,platform,status,
        case when brief->>'failureReason' in ('generation_unknown','generation_failed','completion_failed','source_changed','dispatch_uncertain')
          then brief->>'failureReason' when status='unknown' then 'generation_unknown'
          when status='failed' then 'generation_failed' else 'generation_in_progress' end,source_engine,model,created_at
      from noelle.video_recording_briefs b where b.id=${brief.id}
        and not exists(select 1 from noelle.video_recording_brief_attempts a where a.draft_id=b.draft_id)
      on conflict(id) do nothing`;
    const held = await sql`select id from noelle.video_recording_brief_attempts where id=${args.expectedClaimUUID}
      and brief_id=${brief.id} and org_id=${args.orgId} and agent_instance_id=${args.instanceId}
      and draft_id=${args.draftId} and idea_id=${brief.idea_id} and platform=${brief.platform}
      and status in ('building','dispatched','unknown','failed') for update`;
    if (held.length !== 1) return null;
    await sql`update noelle.video_recording_brief_attempts set status='superseded',finished_at=coalesce(finished_at,now()) where id=${args.expectedClaimUUID}`;
    const queued = await sql<{ id: string }[]>`insert into noelle.video_recording_brief_attempts
      (org_id,agent_instance_id,draft_id,idea_id,brief_id,platform,status,reason,predecessor_id,operator_id)
      values (${args.orgId},${args.instanceId},${args.draftId},${brief.idea_id},${brief.id},${brief.platform},'queued','operator_retry',
        ${args.expectedClaimUUID},${args.operatorId}) returning id`;
    await sql`update noelle.video_recording_briefs set status='queued' where id=${brief.id}`;
    return queued[0]?.id ?? null;
  }, null);
}
