-- infra/cloudsql/schema/0094_notification_window_9h.sql
-- Widen the notification lane's window from 6 hours to 9.
--
-- 0093 was right that this bound belongs on the SERVER: the claim RPCs decide
-- what may be drafted and sent, so enforcing it here means a stale notification
-- can never enter the pipeline regardless of what a browser actuator harvested.
-- It picked 6 hours, which was the operator's rule at the time.
--
-- The operator has since widened it to 9 ("allow 9h old"), and the reason is
-- the overnight case: the notifications sweep is deliberately exempt from the
-- write curfew so replies that arrive at night are drafted and waiting at 9am.
-- A 6-hour bound quietly defeated that — a reply posted at 1am had aged out
-- before the first morning sweep could claim it.
--
-- WHY THIS MIGRATION EXISTS AT ALL: 0093 shipped the same day the browser side
-- shipped a DIFFERENT number, from a different session. The server silently
-- won, so the operator's setting appeared to do nothing and nothing errored.
-- The TypeScript callers now derive this from ONE constant
-- (packages/runtime/src/notificationWindow.ts, NOTIFICATION_MAX_AGE_HOURS), and
-- the actuators have tests that fail if their copy drifts from it. SQL cannot
-- import, so THIS FILE IS THE COPY — changing the constant means writing the
-- next migration to match.
--
-- Only the interval changes; everything else is identical to 0093.

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
                    or (cand.payload->>'posted_at')::timestamptz >= now() - interval '9 hours'))
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
                  or (payload->>'posted_at')::timestamptz >= now() - interval '9 hours'))
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
