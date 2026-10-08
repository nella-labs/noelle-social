import type { Sql } from "postgres";
import { assertSafeKey, type ContentStorage } from "@noelle/runtime/content-storage";
import { CONTENT_MEDIA_RESOLVE_MAX_IDS, ContentMediaReadUrlSchema, type ContentMediaResolveInSchema } from "@noelle/contracts";
import type { z } from "zod";
import { ContentMediaWriteError } from "./content-media-binding.js";

/** Resolve only requested ready assets; signing never changes their stored publish fingerprint. */
export async function resolveMediaReadLinks(
  sql: Sql, storage: ContentStorage, input: z.infer<typeof ContentMediaResolveInSchema>,
): Promise<Array<{ id: string; url: string | null }>> {
  if (input.ids.length < 1 || input.ids.length > CONTENT_MEDIA_RESOLVE_MAX_IDS) throw new ContentMediaWriteError("invalid_binding");
  const rows = await sql.begin(async raw => {
    const tx = raw as unknown as Sql;
    await tx`set local lock_timeout='5s'`; await tx`set local statement_timeout='10s'`;
    if (input.agentInstanceId && !(await tx`select id from noelle.agent_instances
      where id=${input.agentInstanceId} and org_id=${input.orgId}`).length) throw new ContentMediaWriteError("invalid_binding");
    return tx<{ id: string; storage_key: string }[]>`select m.id,m.storage_key from noelle.content_media m
      where m.org_id=${input.orgId} and m.id=any(${input.ids}::uuid[]) and m.status='ready'
        and (${input.agentInstanceId ?? null}::uuid is null or m.agent_instance_id is null or m.agent_instance_id=${input.agentInstanceId ?? null})
        and (m.agent_instance_id is null or exists (select 1 from noelle.agent_instances ai
          where ai.id=m.agent_instance_id and ai.org_id=m.org_id))
        and (m.idea_id is null or exists (select 1 from noelle.post_ideas i
          join noelle.agent_instances ai on ai.id=i.agent_instance_id and ai.org_id=i.org_id
          where i.id=m.idea_id and i.org_id=m.org_id and (m.agent_instance_id is null or i.agent_instance_id=m.agent_instance_id)
            and (${input.agentInstanceId ?? null}::uuid is null or i.agent_instance_id=${input.agentInstanceId ?? null})))
        and (m.draft_id is null or exists (select 1 from noelle.post_drafts d
          join noelle.post_ideas i on i.id=d.idea_id and i.org_id=d.org_id and i.agent_instance_id=d.agent_instance_id
          join noelle.agent_instances ai on ai.id=d.agent_instance_id and ai.org_id=d.org_id
          where d.id=m.draft_id and d.org_id=m.org_id and (m.agent_instance_id is null or d.agent_instance_id=m.agent_instance_id)
            and (m.idea_id is null or d.idea_id=m.idea_id)
            and (${input.agentInstanceId ?? null}::uuid is null or d.agent_instance_id=${input.agentInstanceId ?? null})))
      order by m.id limit ${CONTENT_MEDIA_RESOLVE_MAX_IDS}`;
  }) as Array<{ id: string; storage_key: string }>;
  return Promise.all(rows.filter(row => {
    try { assertSafeKey(row.storage_key); }
    catch { return false; }
    return row.storage_key.toLowerCase().startsWith(`${input.orgId.toLowerCase()}/media/`);
  }).map(async row => {
    let url: string | null = null;
    try {
      const resolved = ContentMediaReadUrlSchema.safeParse(await storage.resolveUrl?.(row.storage_key));
      if (resolved.success) url = resolved.data;
    }
    catch { /* A failed refresh cannot acknowledge the stale stored link. */ }
    return { id: row.id, url };
  }));
}
