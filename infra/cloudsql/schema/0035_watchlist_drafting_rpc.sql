-- infra/cloudsql/schema/0035_watchlist_drafting_rpc.sql
-- Drafting claim for the always-on Watchlist lane: ONE pending reply per
-- watched person.
--
-- The keyword lane uses claim_leads_for_drafting (0018) which claims the oldest
-- N classified leads regardless of author. The watchlist lane is different: the
-- operator wants at most one pending reply per watched account at a time. So
-- this RPC claims, per author, that author's NEWEST classified priority lead,
-- and ONLY for authors who have no pending (non-DM) reply approval right now.
-- Once the operator sends / marks-sent that reply (its approval leaves
-- 'pending'), the author becomes eligible again and their newest post is
-- claimed on the next tick. p_cap is a global safety ceiling; the effective cap
-- is the number of watched accounts (one row per author).
--
-- Idempotent: drop the old signature (if any) then create.

drop function if exists noelle.claim_watchlist_leads_for_drafting(uuid, integer);

create function noelle.claim_watchlist_leads_for_drafting(
  p_agent_instance_id uuid,
  p_cap               integer
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

grant execute on function noelle.claim_watchlist_leads_for_drafting(uuid, integer) to noelle_app;

-- Two-lane split: priority (watchlist) leads are now drafted EXCLUSIVELY by the
-- watchlist claim above (one reply per person). So the keyword-lane claim must
-- exclude priority leads — otherwise it would also draft watched-people leads,
-- ignoring the one-per-person rule. The body changes but the return type is
-- unchanged; Postgres still rejects CREATE OR REPLACE that "changes the return
-- type" for an existing function in some cases, so DROP + CREATE (and re-GRANT,
-- since DROP drops the grant).
drop function if exists noelle.claim_leads_for_drafting(uuid, integer);
create function noelle.claim_leads_for_drafting(
  p_agent_instance_id uuid,
  p_batch             integer
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
    order by created_at asc
    for update skip locked
    limit p_batch
  )
  returning id, external_id, payload, author_handle, author_id, tier,
            classifier_label, classifier_score, status, priority;
$$;

grant execute on function noelle.claim_leads_for_drafting(uuid, integer) to noelle_app;
