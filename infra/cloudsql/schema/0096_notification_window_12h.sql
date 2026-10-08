-- infra/cloudsql/schema/0096_notification_window_12h.sql
-- Widen the notification window from 9 hours to 12.
--
-- Operator's call ("allow till 12h"). Same reasoning that took it 6 -> 9: the
-- sweep is deliberately exempt from the write curfew so replies arriving
-- overnight are drafted and waiting in the morning, and a tighter bound quietly
-- defeats that. Twelve covers a normal night with room to spare.
--
-- THREE claim functions carry the bound, not two — 0095 added a third when the
-- notifications lane got its own claim. Missing one would leave that lane
-- enforcing 9h while everything else moved to 12, which is exactly the silent
-- split this file's TypeScript counterpart exists to prevent: the server always
-- wins, quietly, and the operator's setting appears to do nothing.
--
-- The TS callers derive this from packages/runtime/src/notificationWindow.ts
-- (NOTIFICATION_MAX_AGE_HOURS), and both actuators have a parity test that
-- reads THIS FILE off disk and fails if the numbers disagree. SQL cannot
-- import, so this file is the copy that has to be kept honest by hand.

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
                    or (cand.payload->>'posted_at')::timestamptz >= now() - interval '12 hours'))
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
                  or (payload->>'posted_at')::timestamptz >= now() - interval '12 hours'))
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

-- ── the notifications lane's own claim (added in 0095) ──────────────────

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
       -- Fail-open on an undateable stamp: the sweep only ever harvests recent
       -- cards, so a missing posted_at is a scraping gap, not an old reply.
       and (
         l.payload->>'posted_at' is null
         or l.payload->>'posted_at' !~ '^\d{4}-'
         or (l.payload->>'posted_at')::timestamptz >= now() - interval '12 hours'
       )
     order by l.created_at asc
     limit greatest(p_cap, 0)
     for update skip locked
  )
  update noelle.leads l
     set status = 'drafting',
         updated_at = now()
    from cand
   where l.id = cand.id
