import type { Sql } from "postgres";
import { CONTENT_PUBLISH_UNCERTAIN_ERROR, CONTENT_PUBLISH_DUPLICATE_ERROR } from "@noelle/contracts";

export class ContentMediaWriteError extends Error {
  constructor(readonly category: "invalid_binding" | "not_found" | "media_changed" | "publication_locked" | "not_ready") { super(category); }
}
export function mediaWriteErrorStatus(error: ContentMediaWriteError): 400 | 404 | 409 {
  return error.category === "not_found" ? 404 : error.category === "invalid_binding" ? 400 : 409;
}
export type MediaBinding = { orgId: string; instanceId: string | null; ideaId: string | null; draftId: string | null; platform: string | null };
type BindingInput = { orgId?: string; instanceId?: string | null; ideaId?: string | null; draftId?: string | null; platform?: string | null };
type Parent = { org_id: string; agent_instance_id: string; idea_id: string; platform: string };

/** Resolve one coherent instance/idea/draft chain, preserving cross-platform idea versions. */
export async function resolveMediaBinding(sql: Sql, input: BindingInput): Promise<MediaBinding> {
  let parent: Parent | undefined;
  if (input.draftId) {
    [parent] = await sql<Parent[]>`select d.org_id,d.agent_instance_id,d.idea_id,d.platform
      from noelle.post_drafts d
      join noelle.post_ideas i on i.id=d.idea_id and i.org_id=d.org_id and i.agent_instance_id=d.agent_instance_id
      join noelle.agent_instances ai on ai.id=d.agent_instance_id and ai.org_id=d.org_id
      where d.id=${input.draftId} limit 1`;
    if (!parent || (input.ideaId != null && input.ideaId !== parent.idea_id)
      || (input.platform != null && input.platform !== parent.platform)) throw new ContentMediaWriteError("invalid_binding");
  } else if (input.ideaId) {
    [parent] = await sql<Parent[]>`select i.org_id,i.agent_instance_id,i.id as idea_id,i.platform
      from noelle.post_ideas i join noelle.agent_instances ai on ai.id=i.agent_instance_id and ai.org_id=i.org_id
      where i.id=${input.ideaId} limit 1`;
    if (!parent) throw new ContentMediaWriteError("invalid_binding");
  }
  if (parent) {
    if ((input.orgId && input.orgId !== parent.org_id)
      || (input.instanceId != null && input.instanceId !== parent.agent_instance_id)) throw new ContentMediaWriteError("invalid_binding");
    return { orgId: parent.org_id, instanceId: parent.agent_instance_id, ideaId: parent.idea_id,
      draftId: input.draftId ?? null, platform: input.platform ?? (input.draftId ? parent.platform : null) };
  }
  if (!input.orgId) throw new ContentMediaWriteError("invalid_binding");
  return { orgId: input.orgId, instanceId: input.instanceId ?? null, ideaId: null, draftId: null, platform: input.platform ?? null };
}

/** Lock both prior and next parents in the publication order before mutable media writes. */
export async function lockMutableMediaBindings(sql: Sql, bindings: MediaBinding[]): Promise<void> {
  const unique = (key: "instanceId" | "ideaId" | "draftId") => [...new Map(bindings.filter(b => b[key]).map(b => [b[key]!, b])).values()]
    .sort((a, b) => a[key]!.localeCompare(b[key]!));
  for (const b of unique("instanceId")) {
    if (!(await sql`select id from noelle.agent_instances where id=${b.instanceId}
      and org_id=${b.orgId} for no key update`).length) throw new ContentMediaWriteError("invalid_binding");
  }
  for (const b of unique("ideaId")) {
    const [idea] = await sql`select status from noelle.post_ideas where id=${b.ideaId}
      and org_id=${b.orgId} and agent_instance_id=${b.instanceId} for no key update`;
    if (!idea) throw new ContentMediaWriteError("invalid_binding");
    if (idea.status === "published") throw new ContentMediaWriteError("publication_locked");
  }
  for (const b of unique("draftId")) {
    const [draft] = await sql`select status,posted_url from noelle.post_drafts where id=${b.draftId}
      and org_id=${b.orgId} and agent_instance_id=${b.instanceId} and idea_id=${b.ideaId}
      and platform=${b.platform} for no key update`;
    if (!draft) throw new ContentMediaWriteError("invalid_binding");
    if (draft.status === "published" || draft.posted_url) throw new ContentMediaWriteError("publication_locked");
  }
  for (const b of unique("ideaId")) {
    const [published] = await sql`select id from noelle.post_drafts where idea_id=${b.ideaId}
      and org_id=${b.orgId} and agent_instance_id=${b.instanceId}
      and (status='published' or posted_url is not null) limit 1`;
    if (published) throw new ContentMediaWriteError("publication_locked");
    const [slot] = await sql`select s.id from noelle.content_schedule_slots s
      join noelle.post_drafts d on d.id=s.draft_id and d.org_id=s.org_id and d.agent_instance_id=s.agent_instance_id
        and d.platform=s.platform and (s.idea_id=d.idea_id or s.idea_id is null)
      where s.org_id=${b.orgId} and s.agent_instance_id=${b.instanceId} and d.idea_id=${b.ideaId}
        and (s.status in ('publishing','published') or s.posted_url is not null or s.posted_tweet_id is not null
          or s.published_at is not null or s.error_message in (${CONTENT_PUBLISH_UNCERTAIN_ERROR},${CONTENT_PUBLISH_DUPLICATE_ERROR})) limit 1`;
    if (slot) throw new ContentMediaWriteError("publication_locked");
  }
}
