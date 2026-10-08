import type { Sql } from "postgres";
import { ContentMediaWriteError, resolveMediaBinding, lockMutableMediaBindings } from "./content-media-binding.js";
import { lockMediaMutation } from "./content-media-lock.js";

/** Commit an immutable cleanup claim before any storage operation; failed cleanup remains retryable. */
export async function claimMediaDeletion(sql: Sql, id: string, orgId: string): Promise<string> {
  return sql.begin(async raw => {
    const tx = raw as unknown as Sql;
    await tx`set local lock_timeout='5s'`; await tx`set local statement_timeout='10s'`;
    await lockMediaMutation(tx, id);
    const [current] = await tx`select org_id,agent_instance_id,idea_id,draft_id,platform,storage_key,status,
      (updated_at <= clock_timestamp()-interval '5 minutes') as stale_upload,
      to_jsonb(m)::text as fingerprint from noelle.content_media m where id=${id} and org_id=${orgId} limit 1`;
    if (!current) throw new ContentMediaWriteError("not_found");
    if (current.status === "uploading" && !current.stale_upload) throw new ContentMediaWriteError("not_ready");
    // A never-ready upload can be cleaned after its former parents move; it was never publishable.
    if (current.status !== "deleting" && current.status !== "uploading") {
      const binding = await resolveMediaBinding(tx, { orgId, instanceId: current.agent_instance_id,
        ideaId: current.idea_id, draftId: current.draft_id, platform: current.platform });
      await lockMutableMediaBindings(tx, [binding]);
    }
    const [claimed] = await tx`update noelle.content_media m set status='deleting',idea_id=null,draft_id=null,
      agent_instance_id=null,updated_at=now() where id=${id} and org_id=${orgId}
      and to_jsonb(m)::text=${current.fingerprint} returning storage_key`;
    if (!claimed) throw new ContentMediaWriteError("media_changed");
    return claimed.storage_key as string;
  }) as Promise<string>;
}

export async function finishMediaDeletion(sql: Sql, id: string, orgId: string, storageKey: string): Promise<void> {
  await sql`delete from noelle.content_media where id=${id} and org_id=${orgId}
    and storage_key=${storageKey} and status='deleting'`;
}

/** A failed, never-ready upload needs cleanup even if its former parents changed. */
export async function abandonMediaUpload(sql: Sql, id: string, orgId: string, storageKey: string): Promise<void> {
  const rows = await sql`update noelle.content_media set status='deleting',idea_id=null,draft_id=null,
    agent_instance_id=null,updated_at=now() where id=${id} and org_id=${orgId}
    and storage_key=${storageKey} and status='uploading' returning id`;
  if (rows.length !== 1) throw new ContentMediaWriteError("media_changed");
}
