import type { Sql } from "postgres";
import {
  rankSavedAuthorRows,
  SAVED_AUTHOR_LIMIT,
  SAVED_POSTS_PER_AUTHOR,
  type SavedEngagementArgs,
  type SavedAuthorEngagement,
  type SavedPostRow,
} from "./saved-author-engagement.js";

export {
  SAVED_AUTHOR_LIMIT,
  SAVED_POSTS_PER_AUTHOR,
  type SavedEngagementArgs,
} from "./saved-author-engagement.js";

function metricPrimitive(sql: Sql, key: "likes" | "replies" | "reposts") {
  return sql`case when jsonb_typeof(l.payload->${key}) in ('number','string')
    and octet_length(l.payload->>${key}) <= 64 then l.payload->>${key} end`;
}

/** Recent saved posts, bounded before transfer; missing metrics remain unknown. */
export async function getSavedAuthorEngagement(
  sql: Sql,
  args: SavedEngagementArgs,
): Promise<SavedAuthorEngagement[]> {
  const validArgs = [args.windowDays, args.limitAuthors, args.samplePosts, args.minPosts].every(
    (value) => Number.isSafeInteger(value) && value > 0,
  );
  if (!validArgs) return [];

  const rows = await sql<SavedPostRow[]>`
    with watched as (
      select lower(regexp_replace(btrim(p.handle), '^@', '')) as handle, owner.org_id
      from noelle.x_watchlist_people p
      join noelle.agent_instances owner on owner.id=p.agent_instance_id and owner.org_id=p.org_id
      where p.agent_instance_id=${args.agentInstanceId} and owner.role='x_intern'
        and regexp_replace(btrim(p.handle), '^@', '') ~ '^[a-zA-Z0-9_]{1,15}$'
      group by 1, owner.org_id
      order by min(p.added_at), 1
      limit ${SAVED_AUTHOR_LIMIT}
    ), recent as (
      select w.handle as author_handle, l.id, l.created_at, l.external_id, l.author_id, l.payload,
        row_number() over (partition by w.handle order by l.created_at desc, l.id desc) as rn
      from noelle.leads l
      join watched w on lower(regexp_replace(btrim(l.author_handle), '^@', ''))=w.handle
      where l.agent_instance_id=${args.agentInstanceId} and l.org_id=w.org_id and l.platform='x'
        and octet_length(l.external_id)<=128
        and l.created_at >= now()-make_interval(days => ${args.windowDays})
        and jsonb_typeof(l.payload->'text')='string' and btrim(l.payload->>'text')<>''
    )
    select l.author_handle, case when octet_length(l.author_id)<=256 then l.author_id end as author_id,
      case when jsonb_typeof(l.payload->'authorName')='string'
        then left(l.payload->>'authorName',200) end as author_name,
      l.external_id, left(l.payload->>'text',800) as text,
      case when jsonb_typeof(l.payload->'url')='string' and octet_length(l.payload->>'url')<=2048
        then l.payload->>'url' end as url,
      ${metricPrimitive(sql, "likes")} as likes,
      ${metricPrimitive(sql, "replies")} as replies,
      ${metricPrimitive(sql, "reposts")} as reposts
    from recent l where l.rn<=${SAVED_POSTS_PER_AUTHOR}
    order by l.author_handle, l.created_at desc, l.id desc
  `;

  return rankSavedAuthorRows(rows);
}
