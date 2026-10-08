-- infra/cloudsql/schema/0020_x_watchlist_profiles.sql
-- LLM-written profile of a watchlisted X person, built by the profiler worker
-- from a deep fetch of their recent tweets (NOT drafted/replied to — history is
-- owned by the profiler, not the reply pipeline). One row per (instance, handle).
-- Drives the per-person relationship view on the dashboard.
-- See docs/superpowers/specs/2026-05-30-watchlist-profiler-design.md.

create table if not exists noelle.x_watchlist_profiles (
  id                uuid        primary key default gen_random_uuid(),
  org_id            uuid        not null references noelle.organizations(id) on delete cascade,
  agent_instance_id uuid        not null references noelle.agent_instances(id) on delete cascade,
  handle            text        not null,                     -- @-stripped, lowercased
  summary           text,                                     -- "who they are / what they like / how to engage"
  topics            jsonb       not null default '[]'::jsonb, -- string[] of top themes
  tone              text,
  engagement_notes  text,
  posts_analyzed    integer     not null default 0,
  model             text,
  generated_at      timestamptz,
  refreshed_at      timestamptz,                              -- null => needs (re)generation
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (agent_instance_id, handle)
);

create index if not exists x_watchlist_profiles_instance_idx
  on noelle.x_watchlist_profiles (agent_instance_id);

-- Profiler scan index: rows that still need (re)generation (null/stale refreshed_at).
create index if not exists x_watchlist_profiles_refresh_idx
  on noelle.x_watchlist_profiles (agent_instance_id, refreshed_at);

grant select, insert, update, delete on noelle.x_watchlist_profiles to noelle_app;

drop trigger if exists x_watchlist_profiles_set_updated_at on noelle.x_watchlist_profiles;
create trigger x_watchlist_profiles_set_updated_at
  before update on noelle.x_watchlist_profiles
  for each row execute function noelle.tg_set_updated_at();
