import { approvalMemoryJoins, memoryBodySql, tenantInstanceSql, trimMemorySql } from "./approvalMemorySql.js";
import { sourceTimestampSql } from "./sourceTimestampSql.js";
import type { Sql, TransactionSql } from "postgres";
import type { RelationshipDmEvidence, RelationshipDmPlatform } from "./relationshipDmTypes.js";

type EvidenceRow = {
  id: string;
  kind: RelationshipDmEvidence["kind"];
  text: string | null;
  url: string | null;
  occurred_at: string | null;
};

export async function relationshipEvidence(
  sql: Sql | TransactionSql,
  args: {
    orgId: string;
    platform: RelationshipDmPlatform;
    authorHandle: string;
    authorId: string | null;
  },
): Promise<RelationshipDmEvidence[]> {
  const rows = await sql<EvidenceRow[]>`
    with accounts as (
      select a.*, lower(regexp_replace(trim(coalesce(a.handle,
        case when a.platform = 'linkedin' then regexp_replace(split_part(split_part(coalesce(a.url, ''), 'linkedin.com/in/', 2), '/', 1), '[?#].*$', '')
             when a.platform = 'x' then regexp_replace(coalesce(nullif(split_part(split_part(coalesce(a.url, ''), 'x.com/', 2), '/', 1), ''), split_part(split_part(coalesce(a.url, ''), 'twitter.com/', 2), '/', 1)), '[?#].*$', '') end)), '^@+', '')) as key
      from noelle.person_social_accounts a join noelle.persons account_person
        on account_person.id = a.person_id and account_person.org_id = a.org_id where a.org_id = ${args.orgId}
    ), recipient_people as (
      select person_id from accounts where platform = ${args.platform} and key = ${args.authorHandle}
    ), aliases as (
      select ${args.platform}::text as platform, ${args.authorHandle}::text as key
      union select a.platform, a.key from accounts a join recipient_people rp on rp.person_id = a.person_id where coalesce(a.key, '') <> ''
    ), vars as (select ${args.authorHandle}::text as h, ${args.authorId ?? null}::text as aid)
    select * from (
      select e.*, row_number() over (partition by kind order by occurred_at desc nulls last, id) as position
      from (
      select 'note:' || p.id::text as id, 'note'::text as kind, p.notes as text, null::text as url, p.updated_at::text as occurred_at, 10 as ord
      from noelle.persons p join recipient_people rp on rp.person_id = p.id where p.org_id = ${args.orgId}
      union all
      select 'post:' || l.platform || ':' || l.id::text, case when l.payload->>'source' = 'notification' then 'received_reply' else 'post' end,
        case when coalesce(l.payload->>'postKind', l.payload->>'post_kind', '') in ('relationship_dm', 'intro_dm') or l.external_id like '%:intro%' then null else coalesce(l.payload->>'text', l.payload->>'original_post_text') end,
        coalesce(l.payload->>'url', l.payload->>'originalPostUrl', l.payload->>'original_post_url'),
        ${sourceTimestampSql(sql, sql`coalesce(nullif(l.payload->>'postedAt', ''), nullif(l.payload->>'posted_at', ''))`, "postgres")}::text, 20
      from noelle.leads l, vars
      where l.org_id = ${args.orgId} and ${tenantInstanceSql(sql, sql`l.org_id`, sql`l.agent_instance_id`)} and (
        exists (select 1 from aliases al where al.platform = l.platform and al.key = lower(regexp_replace(trim(coalesce(l.author_handle, '')), '^@+', '')))
        or (l.platform = ${args.platform} and vars.aid is not null and trim(coalesce(l.author_id, '')) = vars.aid))
      union all
      select 'sent_reply:' || l.platform || ':' || a.id::text, 'sent_reply', ${memoryBodySql(sql)},
        coalesce(l.payload->>'url', l.payload->>'originalPostUrl', l.payload->>'original_post_url'), coalesce(a.decided_at, a.created_at)::text, 30
      from noelle.approvals a ${approvalMemoryJoins(sql)}, vars
      where a.org_id = ${args.orgId} and a.status = 'sent' and coalesce(d.payload->>'kind', 'reply') = 'reply' and (
        exists (select 1 from aliases al where al.platform = l.platform and al.key = lower(regexp_replace(trim(coalesce(l.author_handle, '')), '^@+', '')))
        or (l.platform = ${args.platform} and vars.aid is not null and trim(coalesce(l.author_id, '')) = vars.aid))
      union all
      select 'profile:x:' || xp.id::text, 'profile', concat_ws(E'\n', xp.summary, xp.tone, xp.engagement_notes), 'https://x.com/' || lower(xp.handle), coalesce(xp.generated_at, xp.updated_at)::text, 50
      from noelle.x_watchlist_profiles xp join aliases al on al.platform = 'x' and al.key = lower(regexp_replace(trim(xp.handle), '^@+', '')) where xp.org_id = ${args.orgId} and ${tenantInstanceSql(sql, sql`xp.org_id`, sql`xp.agent_instance_id`)}
      union all
      select 'profile:linkedin:' || lp.id::text, 'profile', concat_ws(E'\n', lp.summary, lp.tone, lp.engagement_notes), 'https://www.linkedin.com/in/' || lower(coalesce(lp.public_id, vars.h)) || '/', coalesce(lp.generated_at, lp.updated_at)::text, 50
      from noelle.linkedin_watchlist_profiles lp left join aliases al on al.platform = 'linkedin' and al.key = lower(trim(coalesce(lp.public_id, ''))), vars
      where lp.org_id = ${args.orgId} and ${tenantInstanceSql(sql, sql`lp.org_id`, sql`lp.agent_instance_id`)} and (al.key is not null or (${args.platform} = 'linkedin' and vars.aid is not null and trim(lp.fsd_profile_id) = vars.aid))
      union all
      select 'profile:x-discovered:' || xd.id::text, 'profile', xd.bio, 'https://x.com/' || lower(xd.handle), xd.last_seen_at::text, 55
      from noelle.x_discovered_people xd join aliases al on al.platform = 'x' and al.key = lower(regexp_replace(trim(xd.handle), '^@+', '')) where xd.org_id = ${args.orgId} and ${tenantInstanceSql(sql, sql`xd.org_id`, sql`xd.agent_instance_id`)}
      union all
      select 'profile:linkedin-discovered:' || ld.id::text, 'profile', ld.headline, 'https://www.linkedin.com/in/' || lower(ld.public_id) || '/', ld.last_seen_at::text, 55
      from noelle.linkedin_discovered_people ld left join aliases al on al.platform = 'linkedin' and al.key = lower(trim(ld.public_id)), vars
      where ld.org_id = ${args.orgId} and ${tenantInstanceSql(sql, sql`ld.org_id`, sql`ld.agent_instance_id`)} and (al.key is not null or (${args.platform} = 'linkedin' and vars.aid is not null and trim(coalesce(ld.fsd_profile_id, '')) = vars.aid))
      ) e where length(${trimMemorySql(sql, sql`coalesce(text, '')`)}) >= 12
    ) bounded
    where position <= case kind when 'note' then 2 when 'post' then 6 when 'received_reply' then 4 when 'sent_reply' then 4 else 4 end
    order by ord, occurred_at desc nulls last, id limit 20`;
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    text: r.text!.trim(),
    url: r.url,
    occurredAt: r.occurred_at,
  }));
}
