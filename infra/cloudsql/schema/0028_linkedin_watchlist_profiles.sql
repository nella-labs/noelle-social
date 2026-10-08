-- infra/cloudsql/schema/0028_linkedin_watchlist_profiles.sql
-- LLM-written profile of a watchlisted LinkedIn person, built by the LinkedIn
-- profiler worker from a deep fetch of their recent posts (the first ~40 posts —
-- these people post a lot, so a deep read is needed to profile them well). The
-- drafter uses this profile to tailor each reply. One row per (instance, person).
-- LinkedIn analogue of noelle.x_watchlist_profiles, keyed by fsd_profile_id.
-- See docs/superpowers/specs/2026-06-08-linkedin-intern-design.md.

create table if not exists noelle.linkedin_watchlist_profiles (
  id                uuid        primary key default gen_random_uuid(),
  org_id            uuid        not null references noelle.organizations(id) on delete cascade,
  agent_instance_id uuid        not null references noelle.agent_instances(id) on delete cascade,
  fsd_profile_id    text        not null,                     -- urn:li:fsd_profile:<id>, prefix stripped
  public_id         text,                                     -- vanity slug (profile URL)
  summary           text,                                     -- "who they are / what they post / how to engage"
  topics            jsonb       not null default '[]'::jsonb, -- string[] of top themes
  tone              text,
  engagement_notes  text,
  posts_analyzed    integer     not null default 0,
  model             text,
  generated_at      timestamptz,
  refreshed_at      timestamptz,                              -- null => needs (re)generation
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (agent_instance_id, fsd_profile_id)
);

create index if not exists linkedin_watchlist_profiles_instance_idx
  on noelle.linkedin_watchlist_profiles (agent_instance_id);

-- Profiler scan index: rows that still need (re)generation (null/stale refreshed_at).
create index if not exists linkedin_watchlist_profiles_refresh_idx
  on noelle.linkedin_watchlist_profiles (agent_instance_id, refreshed_at);

grant select, insert, update, delete on noelle.linkedin_watchlist_profiles to noelle_app;

drop trigger if exists linkedin_watchlist_profiles_set_updated_at on noelle.linkedin_watchlist_profiles;
create trigger linkedin_watchlist_profiles_set_updated_at
  before update on noelle.linkedin_watchlist_profiles
  for each row execute function noelle.tg_set_updated_at();
