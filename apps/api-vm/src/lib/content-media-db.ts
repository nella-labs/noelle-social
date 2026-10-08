import type { Sql } from "postgres";
import type { ContentMediaCreate, ContentMediaLink } from "@noelle/contracts";

import { ContentMediaWriteError, resolveMediaBinding, lockMutableMediaBindings, type MediaBinding } from "./content-media-binding.js";
import { lockMediaMutation } from "./content-media-lock.js";
export { ContentMediaWriteError, resolveMediaBinding } from "./content-media-binding.js";
export type { MediaBinding } from "./content-media-binding.js";

function mediaColumns(sql: Sql) {
  return sql`id,platform,kind,mime_type,storage_key,url,width,height,duration_ms,bytes::int as bytes,
    idea_id,draft_id,caption,status,created_at::text as created_at`;
}

/** Persist the cleanup key before storage dispatch; uploading rows cannot be attached or deleted. */
export async function reserveScopedMediaUpload(sql: Sql, args: {
  id: string; binding: MediaBinding; body: ContentMediaCreate; key: string; bytes: number;
}): Promise<void> {
  await sql.begin(async transaction => {
    const tx = transaction as unknown as Sql, b = args.binding;
    await tx`set local lock_timeout='5s'`; await tx`set local statement_timeout='10s'`;
    await lockMutableMediaBindings(tx, [b]);
    await tx`insert into noelle.content_media
      (id,org_id,agent_instance_id,platform,kind,mime_type,storage_key,url,width,height,duration_ms,bytes,idea_id,draft_id,caption,status)
      values (${args.id},${b.orgId},${b.instanceId},${b.platform},${args.body.kind},${args.body.mimeType},${args.key},null,
        ${args.body.width ?? null},${args.body.height ?? null},${args.body.durationMs ?? null},${args.bytes},${b.ideaId},${b.draftId},${args.body.caption ?? null},'uploading')`;
  });
}

/** Own the upload through finalization on one connection; the durable reservation already committed. */
export async function completeScopedMediaUpload(sql: Sql, args: {
  id: string; binding: MediaBinding; key: string; put(): Promise<{ url: string }>;
}): Promise<Record<string, unknown>> {
  return sql.begin(async transaction => {
    const tx = transaction as unknown as Sql;
    await tx`set local lock_timeout='5s'`; await tx`set local statement_timeout='10s'`;
    // The lease lasts until storage creation/signing ends; an independent SQL idle clock cannot release it early.
    await tx`set local idle_in_transaction_session_timeout='0'`;
    await lockMediaMutation(tx, args.id);
    const [pending] = await tx`select id from noelle.content_media
      where id=${args.id} and org_id=${args.binding.orgId} and storage_key=${args.key} and status='uploading'
      and agent_instance_id is not distinct from ${args.binding.instanceId}
      and idea_id is not distinct from ${args.binding.ideaId} and draft_id is not distinct from ${args.binding.draftId}
      and platform is not distinct from ${args.binding.platform}`;
    if (!pending) throw new ContentMediaWriteError("media_changed");
    const { url } = await args.put();
    await lockMutableMediaBindings(tx, [args.binding]);
    const [row] = await tx`update noelle.content_media set url=${url},status='ready',updated_at=now()
      where id=${args.id} and org_id=${args.binding.orgId} and storage_key=${args.key} and status='uploading'
      and agent_instance_id is not distinct from ${args.binding.instanceId}
      and idea_id is not distinct from ${args.binding.ideaId} and draft_id is not distinct from ${args.binding.draftId}
      and platform is not distinct from ${args.binding.platform}
      returning ${mediaColumns(tx)}`;
    if (!row) throw new ContentMediaWriteError("media_changed");
    return row;
  }) as Promise<Record<string, unknown>>;
}

/** Serialize attachment edits, then recheck the fresh row after locking its target parents. */
export async function relinkScopedMedia(sql: Sql, args: { id: string; orgId: string; body: ContentMediaLink }): Promise<Record<string, unknown>> {
  return sql.begin(async transaction => {
    const tx = transaction as unknown as Sql;
    await tx`set local lock_timeout='5s'`; await tx`set local statement_timeout='10s'`;
    await lockMediaMutation(tx, args.id);
    const [current] = await tx<{ draft_id: string | null; idea_id: string | null; agent_instance_id: string | null; platform: string | null; status: string; fingerprint: string }[]>`
      select draft_id,idea_id,agent_instance_id,platform,status,to_jsonb(m)::text as fingerprint
      from noelle.content_media m where id=${args.id} and org_id=${args.orgId} limit 1`;
    if (!current) throw new ContentMediaWriteError("not_found");
    if (current.status !== "ready") throw new ContentMediaWriteError("not_ready");
    const body = args.body;
    let draftId = body.draftId === undefined ? current.draft_id : body.draftId;
    let ideaId = body.ideaId === undefined ? current.idea_id : body.ideaId;
    if (body.ideaId !== undefined && body.ideaId !== current.idea_id && body.draftId === undefined) draftId = null;
    if (body.draftId && body.ideaId === undefined) ideaId = null;
    if (body.draftId && body.ideaId === null) throw new ContentMediaWriteError("invalid_binding");
    const binding = await resolveMediaBinding(tx, { orgId: args.orgId, draftId, ideaId,
      ...(!draftId && !ideaId ? { instanceId: current.agent_instance_id, platform: current.platform } : {}) });
    const prior = await resolveMediaBinding(tx, { orgId: args.orgId, draftId: current.draft_id, ideaId: current.idea_id,
      instanceId: current.agent_instance_id, platform: current.platform });
    await lockMutableMediaBindings(tx, [prior, binding]);
    const [row] = await tx`update noelle.content_media m set draft_id=${binding.draftId},idea_id=${binding.ideaId},
      agent_instance_id=${binding.instanceId},platform=${binding.platform},updated_at=now()
      where id=${args.id} and org_id=${args.orgId} and to_jsonb(m)::text=${current.fingerprint}
      returning ${mediaColumns(tx)}`;
    if (!row) throw new ContentMediaWriteError("media_changed");
    return row;
  }) as Promise<Record<string, unknown>>;
}
