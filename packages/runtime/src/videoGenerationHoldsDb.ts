import type { Sql } from "postgres";
import { z } from "zod";
import { readSourceTimestamp } from "./sourceValues.js";
import { withVideoOwner } from "./videoOwnerDb.js";

export type VideoHoldKind = "teardown" | "recording_brief";
export interface VideoGenerationHold {
  id: string; sourceId: string; platform: string; kind: VideoHoldKind;
  status: string; reason: string; createdAt: string; providerExecutionMayBeUnresolved: true;
}
const CursorSchema = z.object({ v: z.literal(1), org: z.string().uuid(), instance: z.string().uuid(),
  at: z.string().max(64).refine(value => readSourceTimestamp(value) !== null),
  id: z.string().uuid(), kind: z.enum(["teardown", "recording_brief"]) }).strict();
const reasons = new Set(["generation_in_progress", "generation_unknown", "generation_failed", "completion_failed",
  "source_changed", "dispatch_uncertain"]);

/** Scoped keyset pages preserve native timestamp precision; only returned rows are counted. */
export function listVideoGenerationHolds(parent: Sql, args: { instanceId: string; orgId: string; limit?: number;
  kind?: VideoHoldKind | "all"; cursor?: string }): Promise<{ holds: VideoGenerationHold[]; returnedCount: number; nextCursor: string | null }> {
  const limit = args.limit ?? 20;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) throw new RangeError("Video hold page size must be 1..50");
  const kind = args.kind ?? "all";
  if (!["all", "teardown", "recording_brief"].includes(kind)) throw new RangeError("Invalid Video hold kind");
  let cursor: z.infer<typeof CursorSchema> | undefined;
  if (args.cursor !== undefined) {
    try {
      if (args.cursor.length > 1024) throw new Error("Oversized cursor");
      cursor = CursorSchema.parse(JSON.parse(Buffer.from(args.cursor, "base64url").toString("utf8")));
      if (cursor.org !== args.orgId.toLowerCase() || cursor.instance !== args.instanceId.toLowerCase()) throw new Error("Wrong cursor scope");
    } catch { return Promise.reject(new RangeError("Invalid or foreign Video hold cursor")); }
  }
  return withVideoOwner(parent, args.instanceId, args.orgId, async sql => {
    const rows = await sql<Array<{ id: string; source_id: string; platform: string; kind: VideoHoldKind;
      status: string; reason: string | null; created_at: string }>>`with holds as (
      select a.id,a.clip_id as source_id,a.platform,'teardown'::text as kind,a.status,a.reason,a.created_at
      from noelle.video_teardown_attempts a join noelle.video_clips c on c.id=a.clip_id and c.org_id=a.org_id
        and c.agent_instance_id=a.agent_instance_id and c.platform=a.platform
      where a.org_id=${args.orgId} and a.agent_instance_id=${args.instanceId}
        and a.status in ('building','dispatched','unknown','failed')
      union all
      select coalesce(a.id,b.id),b.draft_id as source_id,b.platform,'recording_brief'::text,
        coalesce(a.status,b.status),coalesce(a.reason,b.brief->>'failureReason'),coalesce(a.created_at,b.created_at)
      from noelle.video_recording_briefs b join noelle.video_drafts d on d.id=b.draft_id and d.org_id=b.org_id
        and d.agent_instance_id=b.agent_instance_id and d.idea_id=b.idea_id and d.platform=b.platform
      join noelle.video_ideas i on i.id=d.idea_id and i.org_id=d.org_id and i.agent_instance_id=d.agent_instance_id and i.platform=d.platform
      left join noelle.video_recording_brief_attempts a on a.brief_id=b.id and a.draft_id=b.draft_id and a.idea_id=b.idea_id
        and a.org_id=b.org_id and a.agent_instance_id=b.agent_instance_id and a.platform=b.platform
        and a.status not in ('superseded','released')
      where b.org_id=${args.orgId} and b.agent_instance_id=${args.instanceId}
        and ((a.status in ('building','dispatched','unknown','failed') and b.status=a.status)
          or (b.status in ('building','dispatched','unknown','failed')
            and not exists(select 1 from noelle.video_recording_brief_attempts prior where prior.draft_id=b.draft_id)))
    ) select id,source_id,platform,kind,status,reason,created_at::text from holds
      where (${kind}='all' or kind=${kind}) and ${cursor
        ? sql`(created_at,id,kind)>((${cursor.at}::text)::timestamptz,${cursor.id}::uuid,${cursor.kind})` : sql`true`}
      order by created_at,id,kind limit ${limit + 1}`;
    const holds: VideoGenerationHold[] = rows.slice(0, limit).map(row => ({ id: row.id, sourceId: row.source_id,
      platform: row.platform, kind: row.kind, status: row.status, reason: row.reason && reasons.has(row.reason) ? row.reason : "generation_in_progress",
      createdAt: row.created_at, providerExecutionMayBeUnresolved: true }));
    const last = holds.at(-1);
    const nextCursor = rows.length > limit && last ? Buffer.from(JSON.stringify({ v: 1, org: args.orgId.toLowerCase(),
      instance: args.instanceId.toLowerCase(), at: last.createdAt, id: last.id, kind: last.kind })).toString("base64url") : null;
    return { holds, returnedCount: holds.length, nextCursor };
  }, { holds: [], returnedCount: 0, nextCursor: null });
}
