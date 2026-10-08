import type { Sql } from "postgres";
import { VideoTeardownSchema, type VideoTeardown } from "@noelle/contracts";
import { withVideoOwner } from "./videoOwnerDb.js";

export interface ClipForTeardown {
  id: string; platform: string; external_id: string; author_handle: string; caption: string; url: string;
  video_url: string | null; thumb_url: string | null;
  views: number | null; likes: number | null; comments: number | null; shares: number | null;
  duration_s: string | null; deep_tier: boolean;
}
export interface TeardownClaim extends ClipForTeardown {
  claim_id: string; org_id: string; agent_instance_id: string; source_snapshot: Record<string, unknown>;
}
export interface WriteVideoTeardownArgs {
  orgId: string; instanceId: string; clipId: string; platform: string; teardown: VideoTeardown;
  transcript: string | null; tier: "bulk" | "deep"; model: string;
}
export type TeardownFailureReason = "extraction_failed" | "preparation_failed" | "generation_unknown" | "generation_failed"
  | "completion_failed" | "source_changed" | "dispatch_uncertain";

/** Exact stored source values, before display normalization. The query alias is c. */
export function teardownSnapshotSql(sql: Sql) {
  return sql`jsonb_build_object('platform',c.platform,'external_id',c.external_id,'author_handle',c.author_handle,
    'caption',c.caption,'url',c.url,'video_url',c.video_url,'thumb_url',c.thumb_url,
    'views',c.views::text,'likes',c.likes::text,'comments',c.comments::text,'shares',c.shares::text,
    'duration_s',c.duration_s::text,'deep_tier',c.deep_tier,'pulled_at',c.pulled_at::text)`;
}

/** Short current-owner transaction; no extraction or generation runs in this callback. */
export function withTeardownClaim<T>(parent: Sql, claim: TeardownClaim, statuses: string[], checkSnapshot: boolean,
  operation: (sql: Sql) => Promise<T>, rejected: T): Promise<T> {
  return withVideoOwner(parent, claim.agent_instance_id, claim.org_id, async sql => {
    const clips = await sql`select c.id from noelle.video_clips c
      where c.id=${claim.id} and c.org_id=${claim.org_id} and c.agent_instance_id=${claim.agent_instance_id}
        and (${checkSnapshot}=false or (c.platform=${claim.platform}
          and ${teardownSnapshotSql(sql)}=${sql.json(claim.source_snapshot as never)})) for share`;
    if (clips.length !== 1) return rejected;
    const rows = await sql`select id from noelle.video_teardown_attempts where id=${claim.claim_id}
      and org_id=${claim.org_id} and agent_instance_id=${claim.agent_instance_id}
      and clip_id=${claim.id} and platform=${claim.platform} and status=any(${statuses})
      and (${checkSnapshot}=false or source_snapshot=${sql.json(claim.source_snapshot as never)}) for update`;
    return rows.length === 1 ? operation(sql) : rejected;
  }, rejected);
}

/** The sole transaction-local completed-output writer used by compatibility and claim completion. */
export async function writeVideoTeardownInTransaction(sql: Sql, args: WriteVideoTeardownArgs): Promise<string | null> {
  const parsed = VideoTeardownSchema.safeParse(args.teardown);
  if (!parsed.success) return null;
  const clips = await sql`select id from noelle.video_clips where id=${args.clipId}
    and org_id=${args.orgId} and agent_instance_id=${args.instanceId} and platform=${args.platform} for share`;
  if (clips.length !== 1) return null;
  const existing = await sql<Array<{ coherent: boolean }>>`
    select org_id=${args.orgId} and agent_instance_id=${args.instanceId} and platform=${args.platform} as coherent
    from noelle.video_teardowns where clip_id=${args.clipId} for update`;
  if (existing.some(row => !row.coherent)) return null;
  const rows = await sql<{ id: string }[]>`insert into noelle.video_teardowns
    (org_id,agent_instance_id,clip_id,platform,teardown,transcript,tier,model,generated_at)
    values (${args.orgId},${args.instanceId},${args.clipId},${args.platform},
      ${sql.json(parsed.data as never)},${args.transcript},${args.tier},${args.model},now())
    on conflict(clip_id) do update set teardown=excluded.teardown,transcript=excluded.transcript,
      tier=excluded.tier,model=excluded.model,generated_at=now()
    where video_teardowns.org_id=excluded.org_id and video_teardowns.agent_instance_id=excluded.agent_instance_id
      and video_teardowns.platform=excluded.platform returning id`;
  return rows[0]?.id ?? null;
}

export function upsertTeardown(sql: Sql, args: WriteVideoTeardownArgs): Promise<boolean> {
  return withVideoOwner(sql, args.instanceId, args.orgId,
    async tx => (await writeVideoTeardownInTransaction(tx, args)) !== null, false);
}
