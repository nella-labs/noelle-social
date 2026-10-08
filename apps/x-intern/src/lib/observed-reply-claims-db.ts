import type { Sql } from "postgres";
import { sourceTimestampSql, unattendedReplyReviewSql } from "@noelle/runtime";
import type { LeadRow } from "./leads-db.js";
import { OBSERVED_REPLY_ACTIVE_CAP, OBSERVED_TRENDING_TARGET, replyAuthorKey, replyConversationId, replyConversationIdSql, scoreReplyOpportunity, selectReplyOpportunities } from "./reply-opportunity.js";

/** Claim qualified browser posts with bounded ranking and per-instance capacity. */
export async function claimObservedLeadsForDrafting(
  sql: Sql,
  args: { agentInstanceId: string; cap: number },
): Promise<LeadRow[]> {
  const cap = Number.isFinite(args.cap) ? Math.max(0, Math.min(12, Math.floor(args.cap))) : 0;
  if (cap === 0) return [];
  return sql.begin(async (tx) => {
    await tx`select set_config('lock_timeout', '5s', true), set_config('statement_timeout', '10s', true)`;
    // Lock in its own statement: a waiting claimant then reads a fresh snapshot.
    await tx`select pg_advisory_xact_lock(hashtextextended(${'x-observed:' + args.agentInstanceId}, 0))`;
    const instances = await tx<Array<{ org_id: string }>>`
      select org_id from noelle.agent_instances where id = ${args.agentInstanceId}::uuid
    `;
    const orgId = instances[0]?.org_id;
    if (!orgId) return [];
    const now = new Date();
    const occupied = await tx<LeadRow[]>`
      select l.id, l.payload, l.author_handle, l.external_id
      from noelle.leads l
      where l.agent_instance_id = ${args.agentInstanceId}::uuid
        and l.platform = 'x' and l.payload->>'source' = 'extension_observed'
        and (l.status = 'drafting' or exists (
          select 1 from noelle.approvals a join noelle.drafts d on d.id = a.draft_id
          where a.lead_id = l.id and a.status = 'pending'
            and coalesce(d.payload->>'kind', 'reply') = 'reply'
            and ${unattendedReplyReviewSql(tx, tx`d.payload`)}
        ))
      limit ${OBSERVED_REPLY_ACTIVE_CAP}
    `;
    const slots = Math.min(cap, OBSERVED_REPLY_ACTIVE_CAP - occupied.length);
    if (slots <= 0) return [];
    const candidates = await tx<(LeadRow & { created_at: Date })[]>`
      with newest as (
        select distinct on (lower(btrim(l.author_handle, '@ '))) l.id
        from noelle.leads l
        where l.agent_instance_id = ${args.agentInstanceId}::uuid
          and l.platform = 'x' and l.status = 'classified'
          and l.payload->>'source' = 'extension_observed'
          and l.payload->'classifier'->>'judge' = 'jev'
          and l.payload->>'reply_requested' is distinct from 'true'
        order by lower(btrim(l.author_handle, '@ ')),
          case when ${sourceTimestampSql(tx, tx`l.payload->>'posted_at'`)} <= now() + interval '5 minutes'
            then ${sourceTimestampSql(tx, tx`l.payload->>'posted_at'`)} end desc nulls last,
          l.created_at desc, l.id
      )
      select l.id, l.external_id, l.payload, l.author_handle, l.author_id,
             l.tier, l.classifier_label, l.classifier_score, l.status, l.priority, l.created_at
      from noelle.leads l
      join newest n on n.id = l.id
      where l.agent_instance_id = ${args.agentInstanceId}::uuid
        and l.platform = 'x' and l.status = 'classified'
        and l.payload->>'source' = 'extension_observed'
        and l.payload->'classifier'->>'judge' = 'jev'
        and l.payload->>'reply_requested' is distinct from 'true'
        and not exists (
          select 1 from noelle.approvals a
          join noelle.leads la on la.id = a.lead_id
          join noelle.drafts d on d.id = a.draft_id
          where la.agent_instance_id = ${args.agentInstanceId}::uuid
            and (lower(btrim(la.author_handle, '@ ')) = lower(btrim(l.author_handle, '@ '))
              or ${replyConversationIdSql(tx, tx`la.payload`)}
                = ${replyConversationIdSql(tx, tx`l.payload`)})
            and a.status = 'pending' and coalesce(d.payload->>'kind', 'reply') = 'reply'
            and ${unattendedReplyReviewSql(tx, tx`d.payload`)}
        )
      order by l.classifier_score desc nulls last, l.created_at desc, l.id
      limit 200
      for update of l skip locked
    `;
    if (candidates.length === 0) return [];
    const authors = [...new Set(candidates.map((l) => replyAuthorKey(l.author_handle)).filter(Boolean))];
    const conversations = candidates.map((l) => replyConversationId(l.payload)).filter((id): id is string => id !== null);
    const targets = [...new Set([...candidates.map((l) => l.external_id), ...conversations].filter(Boolean))];
    const evidence = await tx<Array<{ kind: string; id: string }>>`
      with blocked as (
        select l.external_id as tweet_id, l.payload
        from noelle.approvals a
        join noelle.drafts d on d.id = a.draft_id
        join noelle.leads l on l.id = a.lead_id
        where a.org_id = ${orgId}::uuid and a.status = 'sent' and l.platform = 'x'
          and coalesce(d.payload->>'kind', 'reply') = 'reply'
        union
        select a.tweet_id, coalesce(l.payload, '{}'::jsonb)
        from noelle.x_activity a
        left join noelle.leads l on l.org_id = a.org_id and l.platform = 'x' and l.external_id = a.tweet_id
        where a.org_id = ${orgId}::uuid and a.type in ('reply', 'skip') and a.tweet_id is not null
        union
        select c.tweet_id, coalesce(l.payload, '{}'::jsonb)
        from noelle.x_reply_claims c
        left join noelle.leads l on l.org_id = c.org_id and l.platform = 'x' and l.external_id = c.tweet_id
        where c.org_id = ${orgId}::uuid
      )
      select 'target' as kind, tweet_id as id from blocked
      where tweet_id = any(${targets}::text[])
      union
      select 'conversation' as kind,
        ${replyConversationIdSql(tx, tx`payload`)} as id
      from blocked
      where ${replyConversationIdSql(tx, tx`payload`)} = any(${conversations}::text[])
      limit 600
    `;
    const recent = await tx<Array<{ author: string; count: number }>>`
      select lower(btrim(l.author_handle, '@ ')) as author, count(distinct l.id)::int as count
      from noelle.approvals a join noelle.drafts d on d.id = a.draft_id
      join noelle.leads l on l.id = a.lead_id
      where a.org_id = ${orgId}::uuid and a.status = 'sent' and l.platform = 'x'
        and coalesce(d.payload->>'kind', 'reply') = 'reply'
        and coalesce(d.sent_at, a.decided_at, a.created_at) >= now() - interval '24 hours'
        and lower(btrim(l.author_handle, '@ ')) = any(${authors}::text[])
      group by lower(btrim(l.author_handle, '@ '))
    `;
    const occupiedConversations = occupied.map((l) => replyConversationId(l.payload)).filter((id): id is string => id !== null);
    const picked = selectReplyOpportunities(candidates, {
      now, slots, trendNeed: Math.max(0, OBSERVED_TRENDING_TARGET
        - occupied.filter((l) => scoreReplyOpportunity(l, now, 0).trending).length),
      occupiedAuthors: new Set(occupied.map((l) => replyAuthorKey(l.author_handle)).filter(Boolean)),
      occupiedConversations: new Set(occupiedConversations),
      blockedTargets: new Set(evidence.filter((e) => e.kind === 'target').map((e) => e.id)),
      blockedConversations: new Set(evidence.filter((e) => e.kind === 'conversation').map((e) => e.id)),
      recentAuthorReplies: new Map(recent.map((r) => [r.author, r.count])),
    });
    if (picked.length === 0) return [];
    const metadata = picked.map((lead, index) => ({ id: lead.id,
      opportunity: { ...lead.opportunity, rank: index + 1 } }));
    const rows = await tx<LeadRow[]>`
      update noelle.leads l
      set status = 'drafting', updated_at = now(),
          payload = l.payload || jsonb_build_object('opportunity', picked.item->'opportunity')
      from jsonb_array_elements(${tx.json(metadata)}::jsonb) as picked(item)
      where l.id = (picked.item->>'id')::uuid and l.status = 'classified'
      returning l.id, l.external_id, l.payload, l.author_handle, l.author_id,
                l.tier, l.classifier_label, l.classifier_score, l.status, l.priority
    `;
    const byId = new Map(rows.map((row) => [row.id, row]));
    return picked.map((lead) => byId.get(lead.id)).filter((lead): lead is LeadRow => lead !== undefined);
  });
}
