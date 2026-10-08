import type { Sql } from "postgres";

export interface FeederSource {
  id: string;
  /** Source handle or public slug, normalized by the source editor. */
  handle: string;
  platform: string;
  displayName: string | null;
  note: string | null;
}
interface StoredSource {
  id: string; handle: string; platform: string; display_name: string | null; note: string | null;
}
function normalize(row: StoredSource): FeederSource {
  return { id: row.id, handle: row.handle, platform: row.platform, displayName: row.display_name, note: row.note };
}

/** Enabled source accounts, oldest-added first, belonging to their current parent. */
export async function listEnabledFeederSources(sql: Sql, instanceId: string): Promise<FeederSource[]> {
  const rows = await sql<StoredSource[]>`
    select s.id,s.handle,s.platform,s.display_name,s.note
    from noelle.account_feeder_sources s
    join noelle.agent_instances a on a.id=s.agent_instance_id and a.org_id=s.org_id
    where s.agent_instance_id=${instanceId} and s.enabled=true
    order by s.created_at asc`;
  return rows.map(normalize);
}

/** The style picker includes disabled sources while retaining platform and owner scope. */
export async function listFeederSources(sql: Sql, args: {
  agentInstanceId: string; platform: string;
}): Promise<FeederSource[]> {
  const rows = await sql<StoredSource[]>`
    select s.id,s.handle,s.platform,s.display_name,s.note
    from noelle.account_feeder_sources s
    join noelle.agent_instances a on a.id=s.agent_instance_id and a.org_id=s.org_id
    where s.agent_instance_id=${args.agentInstanceId} and s.platform=${args.platform}
    order by s.created_at asc`;
  return rows.map(normalize);
}
