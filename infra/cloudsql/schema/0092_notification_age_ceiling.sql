-- infra/cloudsql/schema/0092_notification_age_ceiling.sql
-- Bound the notification exemption added in 0091.
--
-- 0091 was right that the 24h COLD-REPLY ceiling must not apply to someone who
-- replied to US: answering a conversation three days later is normal, and going
-- quiet on them is the actual bad outcome. But it exempted that lane COMPLETELY,
-- and the notifications sweep is gated on a CADENCE (minGapMs between sweeps),
-- not on how far back it reads. So a backlog sweep could surface a months-old
-- mention and, with unattended sending armed, Vega would answer it. Replying to
-- a 6-month-old mention is its own bad look.
--
-- The lane therefore gets its OWN ceiling rather than none: 14 days. Long enough
-- that a real conversation is never dropped (the live leads were 52-96h old),
-- short enough that Vega never resurrects something everyone has forgotten.
--
-- Only the exemption's bound changes; everything else is identical to 0091.

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
language sql
as $$
  update noelle.leads l
  set status = 'drafting', updated_at = now()
  where l.id in (
    select picked.id
    from (
      -- newest classified priority lead per author, skipping authors who
      -- already have a pending reply waiting for the operator
      select distinct on (cand.author_handle)
             cand.id
      from noelle.leads cand
      where cand.agent_instance_id = p_agent_instance_id
        and cand.status = 'classified'
        and cand.priority = true
        -- target-tweet age ceiling (fail-open on undateable posted_at)
        and (
          p_max_age_hours is null or p_max_age_hours <= 0
          -- A NOTIFICATION lead is someone who replied to US. Answering them
          -- three days later is a normal conversation, not stale cold outreach,
          -- so the cold-reply age ceiling does not apply to that lane.
          or (cand.payload->>'source' = 'notification'
               and (cand.payload->>'posted_at' is null
                    or cand.payload->>'posted_at' !~ '^\d{4}-'
                    or (cand.payload->>'posted_at')::timestamptz >= now() - interval '14 days'))
          or cand.payload->>'posted_at' is null
          or cand.payload->>'posted_at' !~ '^\d{4}-'
          or (cand.payload->>'posted_at')::timestamptz >= now() - make_interval(hours => p_max_age_hours)
        )
        and not exists (
          select 1
          from noelle.approvals a
          join noelle.leads la on la.id = a.lead_id
          left join noelle.drafts d on d.id = a.draft_id
          where la.agent_instance_id = p_agent_instance_id
            and la.author_handle = cand.author_handle
            and a.status = 'pending'
            and coalesce(d.payload->>'kind', 'reply') <> 'dm'
        )
      order by cand.author_handle,
               (cand.payload->>'posted_at') desc nulls last,
               cand.created_at desc
    ) picked
    limit p_cap
  )
  returning l.id, l.external_id, l.payload, l.author_handle, l.author_id, l.tier,
            l.classifier_label, l.classifier_score, l.status, l.priority;
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
      -- target-tweet age ceiling (fail-open on undateable posted_at)
      and (
        p_max_age_hours is null or p_max_age_hours <= 0
        -- A NOTIFICATION lead is someone who replied to US; the cold-reply age
        -- ceiling does not apply to answering a conversation. See the header.
        or (payload->>'source' = 'notification'
             and (payload->>'posted_at' is null
                  or payload->>'posted_at' !~ '^\d{4}-'
                  or (payload->>'posted_at')::timestamptz >= now() - interval '14 days'))
        or payload->>'posted_at' is null
        or payload->>'posted_at' !~ '^\d{4}-'
        or (payload->>'posted_at')::timestamptz >= now() - make_interval(hours => p_max_age_hours)
      )
    -- Ordering is gated on p_max_age_hours so this shared RPC is byte-identical
    -- for its 2-arg callers (reddit + linkedin interns, param defaults null):
    --   null  → created_at ASC (legacy oldest-first, unchanged).
    --   set   → freshest tweet first (X passes the ceiling). Oldest-first
    --           drained stale backlog ahead of live conversations; starvation
    --           of old leads is now handled by the expiry sweep, not ordering.
    -- posted_at is ISO 8601 text, which sorts chronologically, so a text sort
    -- needs no cast (mirrors the watchlist RPC).
    order by
      (case when p_max_age_hours is null or p_max_age_hours <= 0 then created_at end) asc,
      (case when p_max_age_hours is not null and p_max_age_hours > 0 then payload->>'posted_at' end) desc nulls last,
      created_at desc
    for update skip locked
    limit p_batch
  )
  returning id, external_id, payload, author_handle, author_id, tier,
            classifier_label, classifier_score, status, priority;
$$;

grant execute on function noelle.claim_leads_for_drafting(uuid, integer, integer) to noelle_app;
