-- infra/cloudsql/schema/0088_reply_freshness_rpcs.sql
-- Reply freshness for the drafting claims: freshest-first + a target-tweet age
-- ceiling.
--
-- Why: a reply account lives on freshness. The keyword-lane claim (0035)
-- drained OLDEST-first with no age bound, so after any backlog or outage the
-- drafter would spend its batches on days-old tweets while fresh ones queued
-- behind them (2026-07: 403 drafted leads, oldest 42.6 days). The X ranker
-- gives replies their value through the live conversation window; a reply
-- drafted days later is noise.
--
-- Both claim RPCs gain a `p_max_age_hours` param (NULL/<=0 = no age filter,
-- preserving the old behavior for existing 2-arg callers during deploy skew —
-- APPLY THIS MIGRATION BEFORE MERGING THE CODE THAT PASSES THE 3RD ARG) and
-- the keyword lane now orders by the tweet's own posted_at DESC (newest
-- first). Leads passed over by the age filter stay 'classified'; the drafter's
-- expiry sweep (expireStaleClassifiedLeads) flips them to 'skipped' with a
-- payload marker so they don't pollute the backlog cap.
--
-- Idempotent: drop + recreate + re-grant (DROP drops the grant).

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
