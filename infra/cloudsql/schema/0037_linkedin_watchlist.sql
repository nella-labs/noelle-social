-- infra/cloudsql/schema/0037_linkedin_watchlist.sql
-- Keyword targeting for the LinkedIn intern (Lyra) — the search lane.
--
-- Until now Lyra's ENTIRE targeting model was her watched connections
-- (noelle.linkedin_watchlist_people): discovery only re-read those people's
-- posts, so a quiet network produced zero leads. This table is Lyra's parallel
-- to Vega's noelle.x_watchlist keyword rows: free-text topics the discovery
-- worker searches LinkedIn-wide (via the Apify post-search actor) to surface
-- HIGH-ENGAGEMENT posts from people OUTSIDE the network that match the objective.
--
-- Keyword-only (no 'handle' kind): LinkedIn has no handle-poll search path the
-- way X does — a specific person is watched via linkedin_watchlist_people, and
-- the keyword lane is for net-new discovery by topic. Engagement floors + the
-- time window ride the shared agent_instances.discovery_config (0032); they are
-- applied client-side in the worker (the Apify actor can't filter by engagement).
--
-- Tenancy: every row carries (org_id, agent_instance_id); the discovery worker
-- scopes its read by (agent_instance_id), one instance at a time.

create table if not exists noelle.linkedin_watchlist (
  id                uuid          primary key default gen_random_uuid(),
  org_id            uuid          not null references noelle.organizations(id) on delete cascade,
  agent_instance_id uuid          not null references noelle.agent_instances(id) on delete cascade,
  kind              text          not null check (kind in ('keyword')),
  value             text          not null,
  created_at        timestamptz   not null default now(),
  unique (agent_instance_id, kind, value)
);

create index if not exists linkedin_watchlist_instance_idx
  on noelle.linkedin_watchlist (agent_instance_id);

grant select, insert, update, delete on noelle.linkedin_watchlist to noelle_app;
