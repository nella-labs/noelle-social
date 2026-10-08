import type { Sql } from "postgres";
import { RecordingBriefOutputSchema, type RecordingBriefOutput } from "@noelle/contracts";
import { withVideoOwner } from "./videoOwnerDb.js";

export interface ClaimedDraftForBrief {
  claim_id: string; brief_id: string; draft_id: string; org_id: string; agent_instance_id: string;
  idea_id: string; platform: string; script: string; generated_script: string; final_script: string | null;
  draft_updated_at: string; idea_updated_at: string; source_snapshot: Record<string, unknown>;
  structure: unknown; hook: string; concept: string | null;
}
export type BriefFailureReason = "generation_unknown" | "generation_failed" | "completion_failed"
  | "source_changed" | "dispatch_uncertain";
export interface HeldBriefClaim { id: string; status: string; reason: BriefFailureReason | "generation_in_progress" }

/** Exact raw input values; native timestamp text retains microsecond precision. */
export function briefSnapshotSql(sql: Sql) {
  return sql`jsonb_build_object('script',coalesce(nullif(d.final_script,''),d.script),'generated_script',d.script,
    'final_script',d.final_script,'draft_updated_at',d.updated_at::text,'idea_updated_at',i.updated_at::text,
    'structure',d.structure,'hook',i.hook,'concept',i.concept)`;
}

function capturedInput(claim: ClaimedDraftForBrief) {
  return { script: claim.script, generated_script: claim.generated_script, final_script: claim.final_script,
    draft_updated_at: claim.draft_updated_at, idea_updated_at: claim.idea_updated_at,
    structure: claim.structure, hook: claim.hook, concept: claim.concept };
}

/** Lock only SQL state; compare the saved attempt, captured inputs and current source. */
export function withBriefClaim<T>(parent: Sql, claim: ClaimedDraftForBrief, statuses: string[], checkSnapshot: boolean,
  operation: (sql: Sql) => Promise<T>, rejected: T): Promise<T> {
  return withVideoOwner(parent, claim.agent_instance_id, claim.org_id, async sql => {
    const sources = await sql`select d.id from noelle.video_drafts d
      join noelle.video_ideas i on i.id=d.idea_id and i.org_id=d.org_id
        and i.agent_instance_id=d.agent_instance_id and i.platform=d.platform
      where d.id=${claim.draft_id} and d.org_id=${claim.org_id} and d.agent_instance_id=${claim.agent_instance_id}
        and d.idea_id=${claim.idea_id} and d.platform=${claim.platform}
        and (${checkSnapshot}=false or (d.status='ready' and ${briefSnapshotSql(sql)}=${sql.json(claim.source_snapshot as never)}
          and ${briefSnapshotSql(sql)}=${sql.json(capturedInput(claim) as never)})) for update of d,i`;
    if (sources.length !== 1) return rejected;
    const briefs = await sql<{ status: string }[]>`select status from noelle.video_recording_briefs
      where id=${claim.brief_id} and draft_id=${claim.draft_id} and idea_id=${claim.idea_id}
        and org_id=${claim.org_id} and agent_instance_id=${claim.agent_instance_id} and platform=${claim.platform}
        and status=any(${statuses}) for update`;
    if (briefs.length !== 1) return rejected;
    const rows = await sql`select id from noelle.video_recording_brief_attempts
      where id=${claim.claim_id} and brief_id=${claim.brief_id} and status=${briefs[0]!.status}
        and org_id=${claim.org_id} and agent_instance_id=${claim.agent_instance_id}
        and draft_id=${claim.draft_id} and idea_id=${claim.idea_id} and platform=${claim.platform}
        and (${checkSnapshot}=false or source_snapshot=${sql.json(claim.source_snapshot as never)}) for update`;
    return rows.length === 1 ? operation(sql) : rejected;
  }, rejected);
}

/** Persist and acknowledge the exact unchanged input before the generator call. */
export function markBriefDispatched(sql: Sql, claim: ClaimedDraftForBrief): Promise<boolean> {
  return withBriefClaim(sql, claim, ["building"], true, async tx => {
    const rows = await tx`update noelle.video_recording_brief_attempts set status='dispatched',dispatched_at=now()
      where id=${claim.claim_id} and dispatched_at is null returning id`;
    if (rows.length !== 1) return false;
    await tx`update noelle.video_recording_briefs set status='dispatched' where id=${claim.brief_id}`;
    return true;
  }, false);
}

export interface InsertRecordingBriefArgs {
  claim: ClaimedDraftForBrief; runtimeTarget: number | null;
  brief: RecordingBriefOutput; briefMd: string; forgeFollowups: number; sourceEngine: string; model: string;
}

/** The successful output and exact attempt receipt commit together. */
export function insertRecordingBrief(sql: Sql, args: InsertRecordingBriefArgs): Promise<string | null> {
  const parsed = RecordingBriefOutputSchema.safeParse(args.brief);
  if (!parsed.success) return Promise.resolve(null);
  return withBriefClaim(sql, args.claim, ["dispatched"], true, async tx => {
    const receipts = await tx`update noelle.video_recording_brief_attempts set status='complete',reason=null,finished_at=now(),
      configured_engine=coalesce(configured_engine,${args.sourceEngine}),configured_model=coalesce(configured_model,${args.model})
      where id=${args.claim.claim_id} and (configured_engine is null or configured_engine=${args.sourceEngine})
        and (configured_model is null or configured_model=${args.model}) returning id`;
    if (receipts.length !== 1) return null;
    const rows = await tx<{ id: string }[]>`update noelle.video_recording_briefs set runtime_target=${args.runtimeTarget},
      brief=${tx.json(parsed.data as never)},brief_md=${args.briefMd},forge_followups=${args.forgeFollowups},
      source_engine=${args.sourceEngine},model=${args.model},status='ready' where id=${args.claim.brief_id} returning id`;
    if (rows.length !== 1) throw new Error("Recording brief completion acknowledgement is missing");
    return rows[0]!.id;
  }, null);
}

/** Proven preparation failure releases admission while retaining its identity. */
export function revertBriefClaim(sql: Sql, claim: ClaimedDraftForBrief): Promise<boolean> {
  return withBriefClaim(sql, claim, ["building"], false, async tx => {
    const rows = await tx`update noelle.video_recording_brief_attempts set status='released',reason='preparation_failed',finished_at=now()
      where id=${claim.claim_id} and dispatched_at is null returning id`;
    if (rows.length !== 1) return false;
    await tx`update noelle.video_recording_briefs set status='released' where id=${claim.brief_id}`;
    return true;
  }, false);
}

/** Opaque and failed operations remain held with their configured provenance. */
export function markBriefClaimOutcome(sql: Sql, claim: ClaimedDraftForBrief, reason: BriefFailureReason): Promise<boolean> {
  const status = reason === "generation_unknown" || reason === "dispatch_uncertain" ? "unknown" : "failed";
  return withBriefClaim(sql, claim, ["building", "dispatched"], false, async tx => {
    await tx`update noelle.video_recording_brief_attempts set status=${status},reason=${reason},finished_at=now() where id=${claim.claim_id}`;
    await tx`update noelle.video_recording_briefs set status=${status},brief=${tx.json({ failureReason: reason })} where id=${claim.brief_id}`;
    return true;
  }, false);
}
