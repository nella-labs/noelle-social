import { sourceTimestampSql } from "./sourceTimestampSql.js";
import { approvalMemoryJoins } from "./approvalMemorySql.js";
import { RELATIONSHIP_DM_DAILY_CAPS } from "@noelle/contracts";
import type { Sql } from "postgres";
import { relationshipEvidence } from "./relationshipDmEvidenceDb.js";
import type { RelationshipDmCandidate, RelationshipDmPlatform } from "./relationshipDmTypes.js";

type CandidateRow = {
  reservation_id: string;
  request_id: string | null;
  author_id: string | null;
  author_handle: string;
  name: string | null;
  profile_url: string | null;
};

type RequestRow = {
  id: string;
  person_id: string | null;
  recipient_key: string | null;
  author_id: string | null;
  remaining: number;
};

export async function hasPendingRelationshipDmRequests(
  sql: Sql,
  args: { orgId: string; instanceId: string; platform: RelationshipDmPlatform },
): Promise<boolean> {
  const rows = await sql<{ exists: boolean }[]>`
    select exists (
      select 1 from noelle.relationship_dm_requests
      where org_id = ${args.orgId} and agent_instance_id = ${args.instanceId}
        and platform = ${args.platform} and status in ('pending', 'running')
        and processed_count < requested_count
    )`;
  return Boolean(rows[0]?.exists);
}

export async function claimRelationshipDmCandidates(
  sql: Sql,
  args: {
    orgId: string;
    instanceId: string;
    platform: RelationshipDmPlatform;
    limit?: number;
    includeRecurring?: boolean;
  },
): Promise<RelationshipDmCandidate[]> {
  const cap = RELATIONSHIP_DM_DAILY_CAPS[args.platform];
  const requested = Math.max(0, Math.min(args.limit ?? 5, cap));
  if (requested === 0) return [];
  return sql.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(hashtextextended(${`relationship-dm:${args.orgId}:${args.platform}`}, 0))`;
    const [request] = await tx<RequestRow[]>`
      update noelle.relationship_dm_requests
      set status = 'running', started_at = coalesce(started_at, now()), updated_at = now()
      where id = (
        select id from noelle.relationship_dm_requests
        where org_id = ${args.orgId} and agent_instance_id = ${args.instanceId}
          and platform = ${args.platform} and status in ('pending', 'running')
          and processed_count < requested_count
        order by created_at asc
        for update skip locked
        limit 1
      )
      returning id::text, person_id::text, recipient_key, author_id,
        greatest(0, requested_count - processed_count - (
          select count(*)::int from noelle.relationship_dm_reservations res
          where res.request_id = noelle.relationship_dm_requests.id and res.status = 'reserved'
        ))::int as remaining`;
    if (!request && args.includeRecurring === false) return [];

    const budgetRows = await tx<{ remaining: number }[]>`
      select greatest(0, ${cap} - count(*)::int)::int as remaining
      from noelle.relationship_dm_reservations
      where org_id = ${args.orgId} and platform = ${args.platform}
        and reserved_for_date = (now() at time zone 'America/Bogota')::date`;
    const take = Math.min(requested, Number(budgetRows[0]?.remaining ?? 0), request?.remaining ?? requested);
    if (take <= 0) return [];

    const requestId = request?.id ?? null;
    const personId = request?.person_id ?? null;
    const recipientKey = request?.recipient_key ?? null;
    const authorId = request?.author_id ?? null;
    const seedLimit = request ? Math.max(40, take * 20) : 500;
    const rows = await tx<CandidateRow[]>`
      with accounts as materialized (
        select a.*, lower(regexp_replace(trim(coalesce(a.handle,
          case when a.platform = 'linkedin' then regexp_replace(split_part(split_part(coalesce(a.url, ''), 'linkedin.com/in/', 2), '/', 1), '[?#].*$', '')
               when a.platform = 'x' then regexp_replace(coalesce(nullif(split_part(split_part(coalesce(a.url, ''), 'x.com/', 2), '/', 1), ''), split_part(split_part(coalesce(a.url, ''), 'twitter.com/', 2), '/', 1)), '[?#].*$', '') end)), '^@+', '')) as key
        from noelle.person_social_accounts a where a.org_id = ${args.orgId}
      ), usable_posts as materialized (
        select l.*, ${sourceTimestampSql(tx, tx`coalesce(nullif(l.payload->>'postedAt', ''), nullif(l.payload->>'posted_at', ''))`, "postgres")} as post_occurred_at
        from noelle.leads l
        where l.org_id = ${args.orgId}
          and coalesce(l.payload->>'postKind', l.payload->>'post_kind', '') not in ('relationship_dm', 'intro_dm')
          and coalesce(l.payload->>'source', '') <> 'notification'
          and l.external_id not like '%:intro%'
          and length(trim(coalesce(l.payload->>'text', l.payload->>'original_post_text', ''))) >= 12
      ), fresh_posts as materialized (
        select * from usable_posts where post_occurred_at >= now() - interval '7 days'
      ), recent_leads as materialized (
        select * from fresh_posts l
        where l.platform = ${args.platform}
          and l.agent_instance_id = ${args.instanceId}
          and l.author_handle is not null
          and (${recipientKey}::text is null or lower(regexp_replace(trim(coalesce(l.author_handle, '')), '^@+', '')) = lower(regexp_replace(trim(${recipientKey}), '^@+', '')))
          and (${authorId}::text is null or trim(coalesce(l.author_id, '')) = trim(${authorId}))
          and (${personId}::uuid is null or exists (
            select 1 from accounts recent_account
            where recent_account.org_id = l.org_id and recent_account.platform = l.platform
              and recent_account.person_id = ${personId}::uuid
              and recent_account.key = lower(regexp_replace(trim(coalesce(l.author_handle, '')), '^@+', ''))
          ))
        order by l.post_occurred_at desc, l.created_at desc
        limit ${seedLimit}
      ), raw as materialized (
        select p.id as person_id, a.key, null::text as author_id, p.display_name as name, a.url as profile_url, p.notes as note, p.updated_at as seen_at, 60 as rank
        from accounts a join noelle.persons p on p.id = a.person_id and p.org_id = a.org_id
        where a.platform = ${args.platform} and coalesce(a.key, '') <> ''
        union all
        select wp.person_id, lower(regexp_replace(trim(wp.handle), '^@+', '')), null, coalesce(p.display_name, wp.handle), 'https://x.com/' || lower(regexp_replace(trim(wp.handle), '^@+', '')), p.notes, wp.added_at, 10
        from noelle.x_watchlist_people wp left join noelle.persons p on p.id = wp.person_id and p.org_id = wp.org_id
        where ${args.platform} = 'x' and wp.org_id = ${args.orgId} and wp.agent_instance_id = ${args.instanceId}
        union all
        select psa.person_id, lower(trim(lwp.public_id)), trim(lwp.fsd_profile_id), coalesce(lwp.name, p.display_name), coalesce(psa.url, 'https://www.linkedin.com/in/' || lower(trim(lwp.public_id)) || '/'), p.notes, lwp.added_at, 10
        from noelle.linkedin_watchlist_people lwp left join accounts psa on psa.platform = 'linkedin' and psa.key = lower(trim(lwp.public_id))
        left join noelle.persons p on p.id = psa.person_id and p.org_id = lwp.org_id
        where ${args.platform} = 'linkedin' and lwp.org_id = ${args.orgId} and lwp.agent_instance_id = ${args.instanceId} and lwp.public_id is not null
        union all
        select ax.person_id, lower(regexp_replace(trim(xp.handle), '^@+', '')), null, null, 'https://x.com/' || lower(regexp_replace(trim(xp.handle), '^@+', '')), null, coalesce(xp.generated_at, xp.updated_at), 20
        from noelle.x_watchlist_profiles xp left join accounts ax on ax.platform = 'x' and ax.key = lower(regexp_replace(trim(xp.handle), '^@+', ''))
        where ${args.platform} = 'x' and xp.org_id = ${args.orgId} and xp.agent_instance_id = ${args.instanceId}
        union all
        select al.person_id, lower(trim(lp.public_id)), trim(lp.fsd_profile_id), null, 'https://www.linkedin.com/in/' || lower(trim(lp.public_id)) || '/', null, coalesce(lp.generated_at, lp.updated_at), 20
        from noelle.linkedin_watchlist_profiles lp left join accounts al on al.platform = 'linkedin' and al.key = lower(trim(lp.public_id))
        where ${args.platform} = 'linkedin' and lp.org_id = ${args.orgId} and lp.agent_instance_id = ${args.instanceId} and lp.public_id is not null
        union all
        select ax.person_id, lower(regexp_replace(trim(xd.handle), '^@+', '')), trim(xd.author_id), xd.display_name, 'https://x.com/' || lower(regexp_replace(trim(xd.handle), '^@+', '')), null, xd.last_seen_at, 30
        from noelle.x_discovered_people xd left join accounts ax on ax.platform = 'x' and ax.key = lower(regexp_replace(trim(xd.handle), '^@+', ''))
        where ${args.platform} = 'x' and xd.org_id = ${args.orgId} and xd.agent_instance_id = ${args.instanceId}
        union all
        select al.person_id, lower(trim(ld.public_id)), trim(ld.fsd_profile_id), ld.name, 'https://www.linkedin.com/in/' || lower(trim(ld.public_id)) || '/', null, ld.last_seen_at, 30
        from noelle.linkedin_discovered_people ld left join accounts al on al.platform = 'linkedin' and al.key = lower(trim(ld.public_id))
        where ${args.platform} = 'linkedin' and ld.org_id = ${args.orgId} and ld.agent_instance_id = ${args.instanceId}
        union all
        select la.person_id, lower(regexp_replace(trim(l.author_handle), '^@+', '')), coalesce(nullif(trim(l.author_id), ''), trim(lp.fsd_profile_id)), nullif(l.payload->>'authorName', ''),
          case when ${args.platform} = 'x' then 'https://x.com/' || lower(regexp_replace(trim(l.author_handle), '^@+', '')) else 'https://www.linkedin.com/in/' || lower(trim(l.author_handle)) || '/' end,
          null, l.created_at, 40
        from recent_leads l left join accounts la on la.platform = l.platform and la.key = lower(regexp_replace(trim(coalesce(l.author_handle, '')), '^@+', ''))
        left join noelle.linkedin_watchlist_profiles lp on ${args.platform} = 'linkedin' and lp.org_id = l.org_id and lp.agent_instance_id = ${args.instanceId} and lower(trim(lp.public_id)) = lower(trim(l.author_handle))
      ), ranked as materialized (
        select *, row_number() over (partition by coalesce(nullif(author_id, ''), key) order by rank, seen_at desc nulls last) as rn
        from raw
        where coalesce(key, '') <> ''
          and (${personId}::uuid is null or person_id = ${personId})
          and (${recipientKey}::text is null or key = lower(regexp_replace(trim(${recipientKey}), '^@+', '')))
          and (${authorId}::text is null or author_id = trim(${authorId}))
      ), canon as materialized (
        select * from ranked
        where rn = 1
        order by seen_at desc nulls last, key
        limit ${request ? Math.max(40, take * 20) : 300}
      ), lead_key_hits as materialized (
        select distinct c.key
        from canon c join fresh_posts l on l.platform = ${args.platform}
          and lower(regexp_replace(trim(coalesce(l.author_handle, '')), '^@+', '')) = c.key
      ), lead_author_hits as materialized (
        select distinct c.key
        from canon c join fresh_posts l on l.platform = ${args.platform}
          and c.author_id is not null and trim(coalesce(l.author_id, '')) = c.author_id
      ), lead_alias_hits as materialized (
        select distinct c.key
        from canon c join accounts a on c.person_id is not null and a.person_id = c.person_id
        join fresh_posts l on l.platform = a.platform
          and lower(regexp_replace(trim(coalesce(l.author_handle, '')), '^@+', '')) = a.key
      ), lead_hits as materialized (
        select key from lead_key_hits union select key from lead_author_hits union select key from lead_alias_hits
      ), eligible as (
        select c.* from canon c
        where exists (select 1 from lead_hits h where h.key = c.key)
          and not exists (select 1 from noelle.relationship_dm_reservations r where r.org_id = ${args.orgId}
            and ((r.platform = ${args.platform} and (r.recipient_key = c.key or (c.author_id is not null and r.author_id = c.author_id))) or (c.person_id is not null and r.person_id = c.person_id))
            and (r.status in ('reserved', 'queued') or r.reserved_for_date = (now() at time zone 'America/Bogota')::date))
          and not exists (select 1 from noelle.approvals a ${approvalMemoryJoins(tx)}
            where a.org_id = ${args.orgId} and a.status in ('pending', 'sent') and coalesce(d.payload->>'kind', 'reply') = 'dm'
            and l.platform = ${args.platform}
            and (lower(regexp_replace(trim(coalesce(l.author_handle, '')), '^@+', '')) = c.key or (c.author_id is not null and trim(coalesce(l.author_id, '')) = c.author_id)))
        order by c.seen_at desc nulls last, c.key limit ${take}
      ), inserted as (
        insert into noelle.relationship_dm_reservations (org_id, agent_instance_id, request_id, platform, recipient_key, author_id, person_id, recipient_name, profile_url, reserved_for_date)
        select ${args.orgId}, ${args.instanceId}, ${requestId}::uuid, ${args.platform}, key, coalesce(author_id, key), person_id, name, coalesce(profile_url, case when ${args.platform} = 'x' then 'https://x.com/' || key else 'https://www.linkedin.com/in/' || key || '/' end), (now() at time zone 'America/Bogota')::date
        from eligible on conflict do nothing returning id, request_id, recipient_key, author_id, recipient_name, profile_url
      ) select id::text as reservation_id, request_id::text, author_id, recipient_key as author_handle, recipient_name as name, profile_url from inserted`;
    if (request && rows.length === 0) {
      const [pending] = await tx<{ count: number }[]>`
        select count(*)::int from noelle.relationship_dm_reservations
        where request_id = ${request.id} and status = 'reserved'`;
      if (Number(pending?.count ?? 0) === 0) {
        await tx`update noelle.relationship_dm_requests
          set status = 'done', reason = coalesce(reason, 'No eligible saved-context recipients matched this request'), completed_at = now()
          where id = ${request.id}`;
      }
    }
    const out: RelationshipDmCandidate[] = [];
    for (const row of rows)
      out.push({
        reservationId: row.reservation_id,
        requestId: row.request_id,
        authorId: row.author_id ?? row.author_handle,
        authorHandle: row.author_handle,
        name: row.name,
        profileUrl: row.profile_url ?? defaultProfileUrl(args.platform, row.author_handle),
        context: await relationshipEvidence(tx, {
          orgId: args.orgId,
          platform: args.platform,
          authorHandle: row.author_handle,
          authorId: row.author_id,
        }),
      });
    return out;
  });
}

export async function markRelationshipDmResult(
  sql: Sql,
  args: {
    orgId: string;
    reservationId: string;
    status: "queued" | "skipped" | "failed";
    reason?: string | undefined;
    judgeVerdict?: { pass: boolean; reason: string; judgeProvider?: "jev" | "legacy" | "none"; judgeOk?: boolean } | undefined;
  },
): Promise<void> {
  const verdict = args.judgeVerdict ?? (args.reason ? { pass: false, reason: args.reason } : null);
  await sql.begin(async (tx) => {
    const rows = await tx<{ request_id: string | null }[]>`
      update noelle.relationship_dm_reservations
      set status = ${args.status}, reason = ${args.reason ?? null},
        judge_verdict = ${verdict ? JSON.stringify(verdict) : null}::jsonb,
        updated_at = now()
      where org_id = ${args.orgId} and id = ${args.reservationId} and status = 'reserved'
      returning request_id::text`;
    const requestId = rows[0]?.request_id;
    if (!requestId) return;
    await tx`
      update noelle.relationship_dm_requests
      set processed_count = processed_count + 1,
        queued_count = queued_count + case when ${args.status} = 'queued' then 1 else 0 end,
        skipped_count = skipped_count + case when ${args.status} = 'skipped' then 1 else 0 end,
        failed_count = failed_count + case when ${args.status} = 'failed' then 1 else 0 end,
        status = case when processed_count + 1 >= requested_count then 'done' else 'running' end,
        completed_at = case when processed_count + 1 >= requested_count then now() else completed_at end,
        reason = coalesce(${args.reason ?? null}, reason)
      where org_id = ${args.orgId} and id = ${requestId}`;
  });
}

function defaultProfileUrl(platform: RelationshipDmPlatform, handle: string): string {
  return platform === "x" ? `https://x.com/${handle}` : `https://www.linkedin.com/in/${handle}/`;
}
