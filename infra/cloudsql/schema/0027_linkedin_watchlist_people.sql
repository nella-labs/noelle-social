-- infra/cloudsql/schema/0027_linkedin_watchlist_people.sql
-- Watchlist of LinkedIn people the LinkedIn intern (Lyra) must ALWAYS draft a
-- reply for. This is the LinkedIn analogue of noelle.x_watchlist_people, but it
-- is the agent's ENTIRE targeting model: there is no keyword/search discovery on
-- LinkedIn in v1. The watchlist contains operator-selected people, and every
-- NEW post from a person (posted_at >= added_at)
-- is flagged leads.priority = true at discovery and bypasses the classifier.
-- Drafts still queue for approval (human-in-the-loop) — Lyra NEVER auto-sends.
-- See apps/linkedin-intern/src/workers/discoverer.ts.
--
-- People are keyed by fsd_profile_id (the stable urn:li:fsd_profile:<id> value,
-- stored WITHOUT the urn prefix), since LinkedIn has no @handle. public_id is the
-- vanity slug used in profile URLs; name/headline are for the dashboard.
-- Tenancy: every row carries (org_id, agent_instance_id); the discovery worker
-- scopes its read by agent_instance_id.

create table if not exists noelle.linkedin_watchlist_people (
  id                uuid        primary key default gen_random_uuid(),
  org_id            uuid        not null references noelle.organizations(id) on delete cascade,
  agent_instance_id uuid        not null references noelle.agent_instances(id) on delete cascade,
  fsd_profile_id    text        not null,                     -- urn:li:fsd_profile:<id>, prefix stripped
  public_id         text,                                     -- vanity slug (profile URL)
  name              text,
  headline          text,
  objective         text,                                     -- optional per-person engagement steer
  added_at          timestamptz not null default now(),       -- "from this day forward" anchor
  created_at        timestamptz not null default now(),
  unique (agent_instance_id, fsd_profile_id)
);

create index if not exists linkedin_watchlist_people_instance_idx
  on noelle.linkedin_watchlist_people (agent_instance_id);

grant select, insert, update, delete on noelle.linkedin_watchlist_people to noelle_app;
