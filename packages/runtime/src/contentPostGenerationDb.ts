import { randomUUID } from "node:crypto";
import type { Sql, TransactionSql } from "postgres";
import { assertContentPostMutable, ContentPostMutationError, withLockedContentPost,
  type ContentPostIdeaRecord, type ContentPostIdeaScope } from "./contentPostMutationDb.js";

export interface ContentPostGenerationRecord {
  id: string; org_id: string; agent_instance_id: string; idea_id: string;
  platforms: string[]; guidance: string | null; review_required: boolean; source: string; status: string;
  created_at: string; updated_at: string; completed_at: string | null;
}
type GenerationInput = {
  platforms?: string[] | null; guidance?: string | undefined; pin?: boolean;
  journal?: { source: string; reviewRequired: boolean };
  afterQueue?: (tx: TransactionSql, idea: ContentPostIdeaRecord) => Promise<void>;
};
export function nextContentPostTargetPlatforms(idea: Pick<ContentPostIdeaRecord,"target_platforms">, requested: string[] | null): string[] {
  const current = idea.target_platforms ?? [];
  return requested ? [...new Set([...current,...requested])] : current;
}
/** One locked admission serves dashboard regeneration and durable operator tools. */
export async function requestContentPostGeneration(sql: Sql, scope: ContentPostIdeaScope, input: GenerationInput) {
  return withLockedContentPost(sql, scope, async (tx, post) => {
    await assertContentPostMutable(tx, post); const idea = post.idea;
    const platforms = input.platforms?.length ? [...new Set(input.platforms)] : null;
    const expected = platforms ?? (idea.target_platforms?.length ? idea.target_platforms : [idea.platform]);
    const guidance = input.guidance?.trim();
    const [active] = await tx<ContentPostGenerationRecord[]>`select r.*,created_at::text as created_at,
      updated_at::text as updated_at,completed_at::text as completed_at from noelle.post_generation_requests r
      where org_id=${scope.orgId} and agent_instance_id=${idea.agent_instance_id} and idea_id=${idea.id}
        and status in ('queued','drafting','review_pending') order by r.created_at desc limit 1`;
    if (active) {
      if (!guidance && active.platforms.length === expected.length && expected.every(p => active.platforms.includes(p)))
        return { idea, request: active, reused: true };
      throw new ContentPostMutationError("generation_active");
    }
    if (["approved","drafting"].includes(idea.status)) throw new ContentPostMutationError("generation_active");
    const [polish] = await tx`select id from noelle.ideation_requests where org_id=${scope.orgId}
      and agent_instance_id=${idea.agent_instance_id} and idea_id=${idea.id} and mode='polish'
      and status in ('pending','running') limit 1`;
    if (polish) throw new ContentPostMutationError("generation_active");
    let request: ContentPostGenerationRecord | undefined;
    // A completed reviewed request needs a fresh identity; ordinary legacy API generation keeps its null journal.
    const journal = input.journal ?? (idea.generation_request_id
      ? { source: "dashboard", reviewRequired: idea.generation_review_required === true } : undefined);
    if (journal) {
      [request] = await tx<ContentPostGenerationRecord[]>`insert into noelle.post_generation_requests
        (id,org_id,agent_instance_id,idea_id,platforms,guidance,review_required,source,status)
        values (${randomUUID()},${scope.orgId},${idea.agent_instance_id},${idea.id},${expected}::text[],
          ${guidance ?? null},${journal.reviewRequired},${journal.source},'queued')
        returning *,created_at::text as created_at,updated_at::text as updated_at,completed_at::text as completed_at`;
      if (!request) throw new Error("Post generation request returned no receipt");
    }
    const targets = nextContentPostTargetPlatforms(idea,platforms);
    await tx`update noelle.post_ideas set status='approved',target_platforms=${targets}::text[],
      pending_platforms=${platforms}::text[],generation_request_id=${request?.id ?? null},
      generation_review_required=${request?.review_required ?? false},updated_at=now()
      where id=${idea.id} and org_id=${scope.orgId}`;
    if (guidance) {
      await tx`insert into noelle.drafter_notes(org_id,agent_instance_id,scope,lane,idea_id,role,body,pinned)
        values (${scope.orgId},${idea.agent_instance_id},'post','posts',${idea.id},'operator',${guidance},false)`;
      if (input.pin) await tx`insert into noelle.drafter_notes(org_id,agent_instance_id,scope,lane,idea_id,role,body,pinned)
        values (${scope.orgId},${idea.agent_instance_id},'standing','posts',null,'operator',${guidance},true)`;
    }
    await input.afterQueue?.(tx,idea);
    return { idea: { ...idea,status: "approved",target_platforms: targets,pending_platforms: platforms,
      generation_request_id: request?.id ?? null,generation_review_required: request?.review_required ?? false }, request, reused: false };
  });
}
export async function requestContentPostPolish(sql: Sql, scope: ContentPostIdeaScope) {
  return withLockedContentPost(sql, scope, async (tx, post) => {
    await assertContentPostMutable(tx, post); const idea = post.idea;
    if (idea.platform !== "linkedin") throw new ContentPostMutationError("platform_not_polishable");
    const [active] = await tx`select id from noelle.ideation_requests where org_id=${scope.orgId}
      and agent_instance_id=${idea.agent_instance_id} and idea_id=${idea.id} and mode='polish'
      and status in ('pending','running') limit 1`;
    if (active || ["approved","drafting"].includes(idea.status)) throw new ContentPostMutationError("generation_active");
    await tx`insert into noelle.ideation_requests(org_id,agent_instance_id,mode,idea_id,status)
      values (${scope.orgId},${idea.agent_instance_id},'polish',${idea.id},'pending')`;
  });
}
export async function replaceContentPostIdea(sql: Sql, scope: ContentPostIdeaScope) {
  return withLockedContentPost(sql, scope, async (tx, post) => {
    await assertContentPostMutable(tx, post); const idea = post.idea;
    await tx`update noelle.post_ideas set status='dismissed',updated_at=now() where id=${idea.id} and org_id=${scope.orgId}`;
    await tx`insert into noelle.ideation_requests(org_id,agent_instance_id,mode,count,topics,week_start,batch_id,target_platforms,status)
      values (${scope.orgId},${idea.agent_instance_id},'single',1,${tx.json(idea.pillar ? [idea.pillar] : [])},null,null,
        ${idea.target_platforms?.length ? idea.target_platforms : [idea.platform]}::text[],'pending')`;
  });
}
