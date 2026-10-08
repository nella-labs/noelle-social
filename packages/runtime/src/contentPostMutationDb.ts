import type { Sql, TransactionSql } from "postgres";
import { CONTENT_PUBLISH_DUPLICATE_ERROR, CONTENT_PUBLISH_UNCERTAIN_ERROR, type PostPatchIn } from "@noelle/contracts";

export class ContentPostMutationError extends Error {
  constructor(readonly category: "post_changed" | "post_locked" | "generation_active" | "platform_not_polishable") { super(category); }
}
export interface ContentPostIdeaRecord {
  id: string; org_id: string; agent_instance_id: string; platform: string;
  target_platforms: string[] | null; pending_platforms: string[] | null;
  generation_request_id: string | null; generation_review_required: boolean | null;
  hook: string; thesis: string | null; angle: string | null; pillar: string | null; status: string;
  source_engine: string | null; model: string | null; suggested_day: string | null;
  batch_id: string | null; created_at: string; updated_at: string;
}
export interface ContentPostDraftRecord {
  id: string; idea_id: string; org_id: string; agent_instance_id: string; platform: string;
  body: string; final_body: string | null; hook: string | null; cta: string | null;
  notes: string | null; category: string | null; stage: string; status: string; posted_url: string | null;
}
export type ContentPostIdeaScope = { orgId: string; ideaId: string; draftId?: never };
export type ContentPostDraftScope = { orgId: string; draftId: string; ideaId?: never };
export type ContentPostScope = ContentPostIdeaScope | ContentPostDraftScope;
type LockedPost = { idea: ContentPostIdeaRecord; draft: ContentPostDraftRecord | undefined };

/** API and operator tools share the publisher's instance → idea → draft lock order. */
export async function withLockedContentPost<T>(sql: Sql, scope: ContentPostScope,
  write: (tx: TransactionSql, post: LockedPost) => Promise<T>): Promise<T> {
  return sql.begin(async tx => {
    await tx`set local lock_timeout='5s'`;
    await tx`set local statement_timeout='10s'`;
    await tx`set local idle_in_transaction_session_timeout='20s'`;
    const [candidate] = scope.draftId
      ? await tx<{ id: string; agent_instance_id: string; platform: string }[]>`select i.id,i.agent_instance_id,i.platform
          from noelle.post_drafts d join noelle.post_ideas i on i.id=d.idea_id
            and i.org_id=d.org_id and i.agent_instance_id=d.agent_instance_id
          where d.id=${scope.draftId} and d.org_id=${scope.orgId} limit 1`
      : await tx<{ id: string; agent_instance_id: string; platform: string }[]>`select id,agent_instance_id,platform
          from noelle.post_ideas where id=${scope.ideaId ?? null} and org_id=${scope.orgId} limit 1`;
    if (!candidate) throw new ContentPostMutationError("post_changed");
    const [instance] = await tx`select id from noelle.agent_instances where id=${candidate.agent_instance_id}
      and org_id=${scope.orgId} and role=${candidate.platform + "_intern"}
      and ${["x","linkedin","reddit"].includes(candidate.platform)} for no key update`;
    if (!instance) throw new ContentPostMutationError("post_changed");
    const [idea] = await tx<ContentPostIdeaRecord[]>`select i.*,suggested_day::text as suggested_day,
      created_at::text as created_at,updated_at::text as updated_at from noelle.post_ideas i
      where id=${candidate.id} and org_id=${scope.orgId} and agent_instance_id=${candidate.agent_instance_id}
        and platform=${candidate.platform} for no key update`;
    if (!idea) throw new ContentPostMutationError("post_changed");
    const [draft] = scope.draftId ? await tx<ContentPostDraftRecord[]>`select * from noelle.post_drafts
      where id=${scope.draftId} and org_id=${scope.orgId} and agent_instance_id=${idea.agent_instance_id}
        and idea_id=${idea.id} for no key update` : [];
    if (scope.draftId && !draft) throw new ContentPostMutationError("post_changed");
    return write(tx, { idea, draft });
  }) as Promise<T>;
}

/** A committed or unresolved external publication cannot be undone by an edit. */
export async function assertContentPostMutable(tx: TransactionSql, post: LockedPost, set = false): Promise<void> {
  if (["published","dismissed"].includes(post.idea.status) || (post.draft &&
    (["published","dismissed"].includes(post.draft.status) || post.draft.posted_url)))
    throw new ContentPostMutationError("post_locked");
  const [barrier] = await tx`select s.id from noelle.content_schedule_slots s
    join noelle.post_drafts d on d.id=s.draft_id and d.org_id=s.org_id
      and d.agent_instance_id=s.agent_instance_id and d.platform=s.platform
      and (s.idea_id=d.idea_id or s.idea_id is null)
    where s.org_id=${post.idea.org_id} and s.agent_instance_id=${post.idea.agent_instance_id}
      and d.idea_id=${post.idea.id} and (
        (${set} and d.platform=${post.draft?.platform ?? null} and d.status in ('draft','ready') and d.posted_url is null)
        or (${!set} and (${post.draft?.id ?? null}::uuid is null or d.id=${post.draft?.id ?? null})))
      and (s.status in ('publishing','published') or s.posted_url is not null or s.posted_tweet_id is not null
        or s.published_at is not null or s.error_message in (${CONTENT_PUBLISH_UNCERTAIN_ERROR},${CONTENT_PUBLISH_DUPLICATE_ERROR})) limit 1`;
  if (barrier) throw new ContentPostMutationError("post_locked");
}

function statusForStage(stage: string) {
  return stage === "posted" ? "published" : ["written","scheduled"].includes(stage) ? "ready" : "draft";
}
export type ContentPostEdit = { orgId: string; draftId: string; platform: string; before: string; after: string | undefined };
export async function markContentPostReady(sql: Sql, scope: ContentPostDraftScope, editedBody?: string): Promise<ContentPostEdit> {
  return withLockedContentPost(sql, scope, async (tx, post) => {
    await assertContentPostMutable(tx, post); const d = post.draft!;
    await tx`update noelle.post_drafts set status='ready',stage=case when stage='draft' then 'written' else stage end,
      final_body=case when ${editedBody !== undefined} then ${editedBody ?? null} else final_body end,
      marked_ready_at=coalesce(marked_ready_at,now()),updated_at=now() where id=${d.id} and org_id=${scope.orgId}`;
    return { orgId: scope.orgId, draftId: d.id, platform: d.platform, before: d.final_body ?? d.body, after: editedBody };
  });
}
export async function patchContentPostDraft(sql: Sql, scope: ContentPostDraftScope, patch: PostPatchIn) {
  return withLockedContentPost(sql, scope, async (tx, post) => {
    await assertContentPostMutable(tx, post); const d = post.draft!;
    const has = (key: keyof PostPatchIn) => Object.prototype.hasOwnProperty.call(patch,key);
    const stage = patch.stage ?? d.stage, status = has("stage") ? statusForStage(stage) : d.status;
    await tx`update noelle.post_drafts set
      hook=case when ${has("hook")} then ${patch.hook ?? null} else hook end,
      cta=case when ${has("cta")} then ${patch.cta ?? null} else cta end,
      notes=case when ${has("notes")} then ${patch.notes ?? null} else notes end,
      category=case when ${has("category")} then ${patch.category ?? null} else category end,
      posted_url=case when ${has("postedUrl")} then ${patch.postedUrl ?? null} else posted_url end,
      final_body=case when ${has("body")} then ${patch.body ?? null} else final_body end,
      stage=${stage},status=${status},updated_at=now(),
      marked_ready_at=case when ${status} in ('ready','published') then coalesce(marked_ready_at,now()) else marked_ready_at end
      where id=${d.id} and org_id=${scope.orgId}`;
    return { status, stage, edit: { orgId: scope.orgId, draftId: d.id, platform: d.platform,
      before: d.final_body ?? d.body, after: patch.body } satisfies ContentPostEdit };
  });
}
export async function markContentPostPosted(sql: Sql, scope: ContentPostDraftScope, postedUrl?: string | null) {
  return withLockedContentPost(sql, scope, async (tx, post) => {
    const d = post.draft!;
    if (d.status === "published") return;
    await assertContentPostMutable(tx, post);
    await tx`update noelle.post_drafts set status='published',stage='posted',
      posted_url=coalesce(${postedUrl ?? null},posted_url),updated_at=now() where id=${d.id} and org_id=${scope.orgId}`;
  });
}
export async function dismissContentPost(sql: Sql, scope: ContentPostScope, set = false) {
  return withLockedContentPost(sql, scope, async (tx, post) => {
    if ((post.draft?.status ?? post.idea.status) === "dismissed") return;
    await assertContentPostMutable(tx, post, set && !!post.draft);
    if (!post.draft) await tx`update noelle.post_ideas set status='dismissed',updated_at=now()
      where id=${post.idea.id} and org_id=${scope.orgId}`;
    else await tx`update noelle.post_drafts set status='dismissed',updated_at=now()
      where org_id=${scope.orgId} and agent_instance_id=${post.idea.agent_instance_id} and idea_id=${post.idea.id}
        and platform=${post.draft.platform} and (${set} or id=${post.draft.id}) and status in ('draft','ready')
        and posted_url is null`;
  });
}
export async function scheduleContentPostIdea(sql: Sql, scope: ContentPostIdeaScope, day: string | null) {
  return withLockedContentPost(sql, scope, async (tx, post) => {
    await assertContentPostMutable(tx, post);
    await tx`update noelle.post_ideas set suggested_day=${day},updated_at=now()
      where id=${post.idea.id} and org_id=${scope.orgId}`;
  });
}
