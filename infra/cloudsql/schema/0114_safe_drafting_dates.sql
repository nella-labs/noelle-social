-- Apply safe source dates and lane-specific freshness to all drafting claims.
drop function if exists noelle.claim_watchlist_leads_for_drafting(uuid, integer);
drop function if exists noelle.claim_watchlist_leads_for_drafting(uuid, integer, integer);

create function noelle.claim_watchlist_leads_for_drafting(
  p_agent_instance_id uuid,
  p_cap               integer,
  p_max_age_hours     integer default null
)
returns table (
  id                uuid,
  external_id       text,
  payload           jsonb,
  author_handle     text,
  author_id         text,
  tier              text,
  classifier_label  text,
  classifier_score  numeric,
  status            text,
  priority          boolean
)
language plpgsql
set lock_timeout = '5s'
as $$
begin
  -- A separate statement gives a waiting caller a fresh committed snapshot.
  perform pg_advisory_xact_lock(hashtextextended('watchlist-drafting:' || p_agent_instance_id::text, 0));
  return query
  with newest as (
    select distinct on (lower(btrim(cand.author_handle, '@ '))) cand.id
    from noelle.leads cand
    join noelle.agent_instances instance on instance.id = cand.agent_instance_id and instance.org_id = cand.org_id
    where cand.agent_instance_id = p_agent_instance_id
      and cand.status = 'classified' and cand.priority = true
      and noelle.x_reply_is_fresh(cand.payload, p_max_age_hours)
      and not exists (
        select 1 from noelle.leads active
        where active.agent_instance_id = p_agent_instance_id
          and lower(btrim(active.author_handle, '@ ')) = lower(btrim(cand.author_handle, '@ '))
          and active.status = 'drafting'
      )
      and not exists (
        select 1 from noelle.approvals a
        join noelle.leads la on la.id = a.lead_id and la.org_id = a.org_id
        left join noelle.drafts d on d.id = a.draft_id and d.org_id = a.org_id
        where la.agent_instance_id = p_agent_instance_id
          and lower(btrim(la.author_handle, '@ ')) = lower(btrim(cand.author_handle, '@ '))
          and a.status = 'pending' and coalesce(d.payload->>'kind', 'reply') <> 'dm'
      )
    order by lower(btrim(cand.author_handle, '@ ')),
      noelle.source_timestamp(cand.payload->>'posted_at') desc nulls last,
      cand.created_at desc, cand.id
  ), picked as (
    select l.id from noelle.leads l join newest n on n.id = l.id
    where l.status = 'classified'
    order by noelle.source_timestamp(l.payload->>'posted_at') desc nulls last, l.created_at desc, l.id
    limit least(greatest(p_cap, 0), 100)
    for update of l skip locked
  )
  update noelle.leads l
  set status = 'drafting', updated_at = now()
  from picked where l.id = picked.id and l.status = 'classified'
  returning l.id, l.external_id, l.payload, l.author_handle, l.author_id, l.tier,
    l.classifier_label, l.classifier_score, l.status, l.priority;
end;
$$;

grant execute on function noelle.claim_watchlist_leads_for_drafting(uuid, integer, integer) to noelle_app;

drop function if exists noelle.claim_leads_for_drafting(uuid, integer);
drop function if exists noelle.claim_leads_for_drafting(uuid, integer, integer);

create function noelle.claim_leads_for_drafting(
  p_agent_instance_id uuid,
  p_batch             integer,
  p_max_age_hours     integer default null
)
returns table (
  id                uuid,
  external_id       text,
  payload           jsonb,
  author_handle     text,
  author_id         text,
  tier              text,
  classifier_label  text,
  classifier_score  numeric,
  status            text,
  priority          boolean
)
language sql
as $$
  update noelle.leads
  set status = 'drafting', updated_at = now()
  where id in (
    select id from noelle.leads
    where agent_instance_id = p_agent_instance_id
      and status = 'classified'
      and priority = false
      and noelle.x_reply_is_fresh(payload, p_max_age_hours)
    order by
      (case when p_max_age_hours is null or p_max_age_hours <= 0 then created_at end) asc,
      (case when p_max_age_hours is not null and p_max_age_hours > 0 then payload->>'posted_at' end) desc nulls last,
      created_at desc
    for update skip locked
    limit least(greatest(p_batch, 0), 500)
  )
  returning id, external_id, payload, author_handle, author_id, tier,
            classifier_label, classifier_score, status, priority;
$$;

grant execute on function noelle.claim_leads_for_drafting(uuid, integer, integer) to noelle_app;

drop function if exists noelle.claim_notification_leads_for_drafting(uuid, integer);

create function noelle.claim_notification_leads_for_drafting(
  p_agent_instance_id uuid,
  p_cap               integer
)
returns table (
  id                uuid,
  external_id       text,
  payload           jsonb,
  author_handle     text,
  author_id         text,
  status            text,
  tier              text,
  classifier_label  text,
  classifier_score  numeric,
  priority          boolean
)
language plpgsql
as $$
begin
  return query
  with cand as (
    select l.id
      from noelle.leads l
     where l.agent_instance_id = p_agent_instance_id
       and l.status = 'classified'
       and coalesce(l.payload->>'source', '') = 'notification'
       and noelle.x_reply_is_fresh(l.payload, 12)
     order by l.created_at asc
     limit greatest(p_cap, 0)
     for update skip locked
  )
  update noelle.leads l
     set status = 'drafting',
         updated_at = now()
    from cand
   where l.id = cand.id
  returning
    l.id,
    l.external_id,
    l.payload,
    l.author_handle,
    l.author_id,
    l.status,
    l.tier,
    l.classifier_label,
    l.classifier_score,
    l.priority;
end;
$$;

grant execute on function noelle.claim_notification_leads_for_drafting(uuid, integer) to noelle_app;
