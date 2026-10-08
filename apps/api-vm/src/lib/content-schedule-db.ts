import type { Sql } from "postgres";
import type { CreateSlotIn } from "@noelle/contracts";

type ScheduleWriteFailure = "instance_not_found" | "invalid_draft" | "auto_publish_forbidden" | "draft_already_scheduled" | "slot_locked" | "slot_not_found";
export class ContentScheduleWriteError extends Error {
  constructor(readonly category: ScheduleWriteFailure) { super(category); }
}
type Owner = { orgId: string; instanceId: string; platform: string; autoPublish: boolean };
type Slot = { id: string; slot_at: string; status: string; auto_publish: boolean };

/** Calendar creation and admission share the publisher's instance-first lock order. */
export async function withContentScheduleOwner<T>(sql: Sql, owner: Owner, write: (tx: Sql) => Promise<T>): Promise<T> {
  return sql.begin(async transaction => {
    const tx = transaction as unknown as Sql;
    await tx`set local lock_timeout='5s'`;
    await tx`set local statement_timeout='10s'`;
    const [instance] = await tx<{ role: string }[]>`select role from noelle.agent_instances
      where id=${owner.instanceId} and org_id=${owner.orgId} for no key update`;
    if (!instance || !["x_intern", "linkedin_intern", "reddit_intern", "video_intern"].includes(instance.role))
      throw new ContentScheduleWriteError("instance_not_found");
    if (owner.autoPublish && (instance.role !== "x_intern" || owner.platform !== "x"))
      throw new ContentScheduleWriteError("auto_publish_forbidden");
    return write(tx);
  }) as Promise<T>;
}

export async function createManualContentSlot(sql: Sql, orgId: string, payload: CreateSlotIn): Promise<Slot> {
  try {
    return await withContentScheduleOwner(sql, { orgId, instanceId: payload.instanceId,
      platform: payload.platform, autoPublish: payload.autoPublish }, async tx => {
      let ideaId: string | null = null;
      if (payload.draftId) {
        const [candidate] = await tx<{ idea_id: string }[]>`select idea_id from noelle.post_drafts
          where id=${payload.draftId} and org_id=${orgId} and agent_instance_id=${payload.instanceId}
            and platform=${payload.platform} limit 1`;
        if (!candidate) throw new ContentScheduleWriteError("invalid_draft");
        const [idea] = await tx`select id from noelle.post_ideas where id=${candidate.idea_id}
          and org_id=${orgId} and agent_instance_id=${payload.instanceId}
          and status not in ('published','dismissed') for no key update`;
        const [draft] = await tx`select id from noelle.post_drafts where id=${payload.draftId}
          and org_id=${orgId} and agent_instance_id=${payload.instanceId} and idea_id=${candidate.idea_id}
          and platform=${payload.platform} and status not in ('published','dismissed')
          and posted_url is null for no key update`;
        if (!idea || !draft) throw new ContentScheduleWriteError("invalid_draft");
        ideaId = candidate.idea_id;
      }
      const [slot] = await tx<Slot[]>`insert into noelle.content_schedule_slots
        (org_id,agent_instance_id,platform,slot_at,status,idea_id,draft_id,auto_publish,window_source)
        values (${orgId},${payload.instanceId},${payload.platform},${payload.slotAt},
          ${payload.draftId ? "ready" : "empty"},${ideaId},${payload.draftId ?? null},${payload.autoPublish},'manual')
        returning id,slot_at,status,auto_publish`;
      if (!slot) throw new Error("content slot insert returned no row");
      return slot;
    });
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "23505"
      && "constraint_name" in error && error.constraint_name === "content_schedule_slots_draft_uq")
      throw new ContentScheduleWriteError("draft_already_scheduled");
    throw error;
  }
}

/** UPDATE rechecks eligibility after waiting for a concurrent publishing transaction. */
export async function mutateContentSlot(sql: Sql, args: { id: string; orgId: string; slotAt?: string }): Promise<Slot> {
  return sql.begin(async transaction => {
    const tx = transaction as unknown as Sql;
    await tx`set local lock_timeout='5s'`;
    await tx`set local statement_timeout='10s'`;
    const [slot] = await tx<Slot[]>`update noelle.content_schedule_slots
      set slot_at=case when ${args.slotAt ?? null}::timestamptz is null then slot_at else ${args.slotAt ?? null}::timestamptz end,
        status=case when ${args.slotAt ?? null}::timestamptz is null then 'skipped' else status end
      where id=${args.id} and org_id=${args.orgId} and status not in ('published','publishing')
        and posted_url is null and posted_tweet_id is null and published_at is null
      returning id,slot_at,status,auto_publish`;
    if (slot) return slot;
    const [exists] = await tx`select id from noelle.content_schedule_slots where id=${args.id} and org_id=${args.orgId} limit 1`;
    throw new ContentScheduleWriteError(exists ? "slot_locked" : "slot_not_found");
  }) as Promise<Slot>;
}
