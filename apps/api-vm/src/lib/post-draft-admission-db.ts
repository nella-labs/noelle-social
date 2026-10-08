import type { Sql } from "postgres";
import type { PostDraftCreate } from "@noelle/contracts";
import { decideAutoCurate, nextPacedSlotAt, type AutoCurateConfig } from "./content-autocurate.js";

/** Compose binding and automatic scheduling share the instance's serial admission order. */
export async function admitGeneratedPostDraft(sql: Sql, args: {
  payload: PostDraftCreate; draftId: string; config: AutoCurateConfig;
  owner: { org_id: string; agent_instance_id: string };
}): Promise<void> {
  const { payload, draftId, config, owner } = args;
  await sql.begin(async tx => {
    await tx`set local lock_timeout='5s'`;
    await tx`set local statement_timeout='10s'`;
    const [instance] = await tx<{ role: string }[]>`
      select role from noelle.agent_instances
      where id=${owner.agent_instance_id} and org_id=${owner.org_id} for no key update
    `;
    const [idea] = await tx<{ status: string }[]>`
      select status from noelle.post_ideas
      where id=${payload.ideaId} and org_id=${owner.org_id} and agent_instance_id=${owner.agent_instance_id}
      for no key update
    `;
    if (!instance || !idea || ["published","dismissed"].includes(idea.status)) return;
    const [draft] = await tx`select id from noelle.post_drafts
      where id=${draftId} and org_id=${owner.org_id} and agent_instance_id=${owner.agent_instance_id}
        and idea_id=${payload.ideaId} and platform=${payload.platform} and generation_request_id is null
        and status not in ('published','dismissed') for no key update`;
    if (!draft) return;

    // One variant binds to one platform-matched waiting slot; the draft has a unique slot identity.
    const bound = await tx`update noelle.content_schedule_slots set draft_id=${draftId},status='ready',updated_at=now()
      where id=(select id from noelle.content_schedule_slots
        where org_id=${owner.org_id} and agent_instance_id=${owner.agent_instance_id}
          and idea_id=${payload.ideaId} and platform=${payload.platform} and draft_id is null
          and status in ('empty','drafting') order by slot_at,id for update skip locked limit 1)
      returning id`;
    if (bound.length) return;

    const decision = decideAutoCurate({ config, ownerRole: instance.role, platform: payload.platform,
      qualityScore: payload.qualityScore, qualityPassed: payload.qualityPassed });
    if (decision.action === "skip") return;
    const slots = await tx<{ window_source: string }[]>`
      select distinct window_source from noelle.content_schedule_slots
      where org_id=${owner.org_id} and agent_instance_id=${owner.agent_instance_id}
        and idea_id=${payload.ideaId} and platform=${payload.platform}
        and status not in ('skipped','failed') and window_source in ('batch','manual','auto') limit 3
    `;
    if (slots.some(slot => slot.window_source === "batch" || slot.window_source === "manual")) return;
    if (decision.action === "dismiss" || slots.some(slot => slot.window_source === "auto")) {
      await tx`update noelle.post_drafts set status='dismissed',updated_at=now()
        where id=${draftId} and org_id=${owner.org_id}`;
      return;
    }
    const [last] = await tx<{ last_at: string | Date | null }[]>`
      select max(slot_at) as last_at from noelle.content_schedule_slots
      where org_id=${owner.org_id} and agent_instance_id=${owner.agent_instance_id}
        and status in ('empty','drafting','drafted','ready','publishing') and slot_at>now()
    `;
    const slotAt = nextPacedSlotAt({ now: new Date(), lastActiveSlotAt: last?.last_at ? new Date(last.last_at) : null,
      leadMinutes: config.leadMinutes, spacingMinutes: config.spacingMinutes });
    await tx`insert into noelle.content_schedule_slots
      (org_id,agent_instance_id,platform,slot_at,status,idea_id,draft_id,auto_publish,window_source,target_kind)
      values (${owner.org_id},${owner.agent_instance_id},${payload.platform},${slotAt},'ready',${payload.ideaId},
        ${draftId},${decision.autoPublish},'auto','post_idea')`;
    await tx`update noelle.post_drafts set status='ready',stage='scheduled',
      marked_ready_at=coalesce(marked_ready_at,now()),updated_at=now() where id=${draftId} and org_id=${owner.org_id}`;
    await tx`update noelle.post_ideas set status='ready',updated_at=now()
      where id=${payload.ideaId} and org_id=${owner.org_id} and status not in ('published','dismissed')`;
  });
}
