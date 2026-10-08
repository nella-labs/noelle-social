import type { Sql } from "postgres";
import type { VideoTeardown } from "@noelle/contracts";
import { readSourceCount } from "./sourceValues.js";
import { withVideoOwner } from "./videoOwnerDb.js";
import { teardownSnapshotSql, withTeardownClaim, writeVideoTeardownInTransaction,
  type TeardownClaim, type TeardownFailureReason } from "./videoTeardownDb.js";
export type { TeardownClaim, TeardownFailureReason } from "./videoTeardownDb.js";

/** Reserve bounded cloud-call admission before external work, using a fresh locked count. */
export function claimClipsForTeardown(parent: Sql,
  args: { instanceId: string; orgId: string; limit: number; dailyCap: number }): Promise<TeardownClaim[]> {
  if (!Number.isSafeInteger(args.limit) || args.limit < 1 || !Number.isSafeInteger(args.dailyCap) || args.dailyCap < 1)
    throw new RangeError("Teardown batch and daily cap must be positive safe integers");
  return withVideoOwner(parent, args.instanceId, args.orgId, async sql => {
    await sql`select pg_advisory_xact_lock(hashtextextended(${'video-teardown-admission:' + args.instanceId.toLowerCase()},0))`;
    const counts = await sql<{ n: string }[]>`select (
      (select count(*) from noelle.video_teardown_attempts a where a.agent_instance_id=${args.instanceId}
        and a.org_id=${args.orgId} and a.admitted_at>=date_trunc('day',now()) and a.status<>'released') +
      (select count(*) from noelle.video_teardowns t join noelle.video_clips c on c.id=t.clip_id
        and c.org_id=t.org_id and c.agent_instance_id=t.agent_instance_id and c.platform=t.platform
        where t.agent_instance_id=${args.instanceId} and t.org_id=${args.orgId}
          and t.generated_at>=date_trunc('day',now()) and not exists(select 1 from noelle.video_teardown_attempts a
            where a.teardown_id=t.id and a.org_id=t.org_id and a.agent_instance_id=t.agent_instance_id
              and a.clip_id=t.clip_id and a.platform=t.platform)))::text as n`;
    const count = readSourceCount(counts[0]?.n);
    if (count === null) throw new Error("Teardown admission count is unknown");
    const room = Math.min(10, args.limit, Math.max(0, args.dailyCap - count));
    if (room === 0) return [];
    const rows = await sql<Array<Omit<TeardownClaim, "views" | "likes" | "comments" | "shares"> & {
      views: string | null; likes: string | null; comments: string | null; shares: string | null;
    }>>`with candidates as materialized (
      select c.id,c.org_id,c.agent_instance_id,c.platform,c.external_id,c.author_handle,c.caption,c.url,
        c.video_url,c.thumb_url,c.views,c.likes,c.comments,c.shares,c.duration_s,c.deep_tier,
        ${teardownSnapshotSql(sql)} as source_snapshot from noelle.video_clips c
      where c.agent_instance_id=${args.instanceId} and c.org_id=${args.orgId} and c.platform in ('instagram','tiktok')
        and not exists(select 1 from noelle.video_teardowns t where t.clip_id=c.id)
        and not exists(select 1 from noelle.video_teardown_attempts a where a.clip_id=c.id
          and a.status not in ('superseded','released') and not (a.status='queued' and a.org_id=c.org_id
            and a.agent_instance_id=c.agent_instance_id and a.platform=c.platform
            and a.admitted_at is null and a.dispatched_at is null))
      order by c.deep_tier desc,case when c.views between 0 and ${Number.MAX_SAFE_INTEGER} then c.views end desc nulls last,c.id
      limit ${room} for update of c skip locked
    ), admitted as (
      insert into noelle.video_teardown_attempts(org_id,agent_instance_id,clip_id,platform,status,reason,source_snapshot,admitted_at)
      select org_id,agent_instance_id,id,platform,'building','generation_in_progress',source_snapshot,now() from candidates
      on conflict(clip_id) where status not in ('superseded','released') do update
        set status='building',reason='generation_in_progress',source_snapshot=excluded.source_snapshot,admitted_at=now()
        where video_teardown_attempts.status='queued' and video_teardown_attempts.admitted_at is null
          and video_teardown_attempts.dispatched_at is null and video_teardown_attempts.org_id=excluded.org_id
          and video_teardown_attempts.agent_instance_id=excluded.agent_instance_id and video_teardown_attempts.platform=excluded.platform
      returning id as claim_id,clip_id
    ) select a.claim_id,c.org_id,c.agent_instance_id,c.source_snapshot,c.id,c.platform,c.external_id,c.author_handle,
      c.caption,c.url,c.video_url,c.thumb_url,c.views::text,c.likes::text,c.comments::text,c.shares::text,
      c.duration_s::text,c.deep_tier from candidates c join admitted a on a.clip_id=c.id
      order by c.deep_tier desc,case when c.views between 0 and ${Number.MAX_SAFE_INTEGER} then c.views end desc nulls last,c.id`;
    return rows.map(row => ({ ...row, views: readSourceCount(row.views), likes: readSourceCount(row.likes),
      comments: readSourceCount(row.comments), shares: readSourceCount(row.shares) }));
  }, []);
}

/** A durable acknowledged dispatch marker is required before calling the analyzer. */
export function markTeardownDispatched(sql: Sql, claim: TeardownClaim): Promise<boolean> {
  return withTeardownClaim(sql, claim, ["building"], true, async tx => {
    const rows = await tx`update noelle.video_teardown_attempts set status='dispatched',dispatched_at=now()
      where id=${claim.claim_id} and status='building' returning id`;
    return rows.length === 1;
  }, false);
}

/** Output and completion receipt commit together for the exact unchanged claimed source. */
export function completeTeardownClaim(sql: Sql, args: { claim: TeardownClaim; teardown: VideoTeardown;
  transcript: string | null; tier: "bulk" | "deep"; model: string }): Promise<boolean> {
  return withTeardownClaim(sql, args.claim, ["dispatched"], true, async tx => {
    const id = await writeVideoTeardownInTransaction(tx, { ...args, orgId: args.claim.org_id,
      instanceId: args.claim.agent_instance_id, clipId: args.claim.id, platform: args.claim.platform });
    if (!id) return false;
    const rows = await tx`update noelle.video_teardown_attempts set status='complete',reason=null,finished_at=now(),teardown_id=${id}
      where id=${args.claim.claim_id} and status='dispatched' returning id`;
    if (rows.length !== 1) throw new Error("Teardown completion acknowledgement is missing");
    return true;
  }, false);
}

/** Uncertain dispatched work stays held; proven preparation or extraction failure frees admission. */
export function markTeardownClaimOutcome(sql: Sql, claim: TeardownClaim,
  status: "unknown" | "failed" | "released", reason: TeardownFailureReason): Promise<boolean> {
  if (status === "released" && reason !== "extraction_failed" && reason !== "preparation_failed")
    throw new RangeError("Only pre-dispatch preparation or extraction failure can release a claim");
  return withTeardownClaim(sql, claim, ["building", "dispatched"], false, async tx => {
    const rows = await tx`update noelle.video_teardown_attempts set status=${status},reason=${reason},finished_at=now()
      where id=${claim.claim_id} and (${status}<>'released' or (status='building' and dispatched_at is null)) returning id`;
    return rows.length === 1;
  }, false);
}

/** Explicit operator recovery retains the predecessor and queues one new identity without network work. */
export function retryVideoTeardown(parent: Sql, args: { orgId: string; instanceId: string; clipId: string;
  expectedClaimUUID: string; operatorId: string }): Promise<string | null> {
  return withVideoOwner(parent, args.instanceId, args.orgId, async sql => {
    const clips = await sql<{ platform: string }[]>`select platform from noelle.video_clips c where c.id=${args.clipId}
      and c.org_id=${args.orgId} and c.agent_instance_id=${args.instanceId} and c.platform in ('instagram','tiktok')
      and not exists(select 1 from noelle.video_teardowns t where t.clip_id=c.id) for share`;
    if (clips.length !== 1) return null;
    const held = await sql`select id from noelle.video_teardown_attempts where id=${args.expectedClaimUUID}
      and org_id=${args.orgId} and agent_instance_id=${args.instanceId} and clip_id=${args.clipId}
      and platform=${clips[0]!.platform} and status in ('building','dispatched','unknown','failed') for update`;
    if (held.length !== 1) return null;
    await sql`update noelle.video_teardown_attempts set status='superseded',finished_at=coalesce(finished_at,now()) where id=${args.expectedClaimUUID}`;
    const rows = await sql<{ id: string }[]>`insert into noelle.video_teardown_attempts
      (org_id,agent_instance_id,clip_id,platform,status,reason,predecessor_id,operator_id)
      values (${args.orgId},${args.instanceId},${args.clipId},${clips[0]!.platform},'queued','operator_retry',${args.expectedClaimUUID},${args.operatorId}) returning id`;
    return rows[0]?.id ?? null;
  }, null);
}
