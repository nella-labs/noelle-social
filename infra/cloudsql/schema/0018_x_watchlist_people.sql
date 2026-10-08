-- infra/cloudsql/schema/0018_x_watchlist_people.sql
-- Watchlist of X people the intern must ALWAYS reply to. Distinct from
-- noelle.x_watchlist (targeting handles + keywords, which stay filtered):
-- every NEW post from a watchlist person (posted_at >= added_at) is flagged
-- leads.priority = true at discovery and bypasses both the classifier
-- on-brand filter and the drafter relevance gate. Drafts still queue for
-- approval (human-in-the-loop).
-- See docs/superpowers/specs/2026-05-29-x-watchlist-people-design.md.
-- Tenancy: every row carries (org_id, agent_instance_id); the discovery worker
-- scopes its read by agent_instance_id, like noelle.x_watchlist.

create table if not exists noelle.x_watchlist_people (
  id                uuid        primary key default gen_random_uuid(),
  org_id            uuid        not null references noelle.organizations(id) on delete cascade,
  agent_instance_id uuid        not null references noelle.agent_instances(id) on delete cascade,
  handle            text        not null,                    -- @-stripped, lowercased
  added_at          timestamptz not null default now(),      -- "from this day forward" anchor
  created_at        timestamptz not null default now(),
  unique (agent_instance_id, handle)
);

create index if not exists x_watchlist_people_instance_idx
  on noelle.x_watchlist_people (agent_instance_id);

grant select, insert, update, delete on noelle.x_watchlist_people to noelle_app;

-- Always-reply marker. Set true at discovery for a watchlist-person post whose
-- posted_at is on/after the person's added_at. Drives the classifier + drafter
-- bypasses. Default false so every existing/normal lead is unaffected.
alter table noelle.leads
  add column if not exists priority boolean not null default false;

-- Re-define claim_leads_for_drafting to surface `priority` so the drafter can
-- skip its relevance gate for watchlist leads. The return type changes, and
-- CREATE OR REPLACE cannot alter a function's OUT columns / return type, so we
-- DROP then CREATE. (Original definition: 0005_leads_full_schema.sql.)
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
    order by created_at asc
    for update skip locked
    limit p_batch
  )
  returning id, external_id, payload, author_handle, author_id, tier,
            classifier_label, classifier_score, status, priority;
$$;

grant execute on function noelle.claim_leads_for_drafting(uuid, integer)
  to noelle_app;
