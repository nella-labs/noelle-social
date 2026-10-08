import type { Fragment, Sql, TransactionSql } from "postgres";

type QuerySql = Sql | TransactionSql;
// Match String.trim() before a row can consume a history query's limit.
const trimCharacters = " \t\n\r\f\v\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff";

export function boundedMemoryLimit(limit: number): number {
  return Number.isFinite(limit) && limit > 0 ? Math.min(100, Math.floor(limit)) : 0;
}

/** Approval history aliases a/d/l must agree on tenant, instance and source. */
export function approvalMemoryJoins(sql: QuerySql): Fragment {
  return sql`join noelle.agent_instances ai on ai.id = a.agent_instance_id and ai.org_id = a.org_id
    join noelle.drafts d on d.id = a.draft_id and d.org_id = a.org_id and d.lead_id = a.lead_id
    join noelle.leads l on l.id = a.lead_id and l.org_id = a.org_id
      and (l.agent_instance_id is null or l.agent_instance_id = a.agent_instance_id)`;
}

/** A cleared edit is authoritative; it must never revive the original body. */
export function memoryBodySql(sql: QuerySql): Fragment {
  return visibleDraftBodySql(sql);
}

/** Visible draft text for alias d; legacy variants are an optional fallback. */
export function visibleDraftBodySql(sql: QuerySql, legacyAngles = false): Fragment {
  const text = (value: Fragment) => sql`case when jsonb_typeof(${value}) = 'string' then ${value} #>> '{}' end`;
  const flat = text(sql`d.payload->'body'`);
  const bundle = (angle: string | Fragment) => {
    const body = text(sql`d.payload->'angles'->(${angle})->'body'`);
    return sql`case when ${trimMemorySql(sql, body)} <> '' then ${body} end`;
  };
  const fallback = legacyAngles ? sql`case
    when d.payload->>'angle' in ('empathetic','technical','contrarian')
      then coalesce(${bundle(sql`d.payload->>'angle'`)}, ${flat})
    else coalesce(${bundle("empathetic")}, ${bundle("technical")}, ${bundle("contrarian")}, ${flat}) end` : flat;
  return sql`case when d.payload ? 'edited_body'
    then case when jsonb_typeof(d.payload->'edited_body') = 'string' then d.payload->>'edited_body' end
    else ${fallback} end`;
}

export function trimMemorySql(sql: QuerySql, value: Fragment): Fragment {
  return sql`btrim(${value}, ${trimCharacters})`;
}

/** Org-wide sources may span valid instances and legacy unassigned leads. */
export function tenantInstanceSql(sql: QuerySql, org: Fragment, instance: Fragment): Fragment {
  return sql`(${instance} is null or exists (select 1 from noelle.agent_instances source_instance
    where source_instance.id = ${instance} and source_instance.org_id = ${org}))`;
}
