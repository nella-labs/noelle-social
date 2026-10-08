-- infra/cloudsql/schema/0044_linkedin_discovered_people.sql
-- Retain every PERSON profile-first discovery qualifies, so the information
-- extracted from discovery is stored — not just used to mint a lead and dropped.
--
-- Feeder A (profile-search) and the keyword lane's author-ICP gate both surface
-- real people who match the operator's ICP. A qualified person who happens to
-- have no recent engaged post yields no lead, so without this table their
-- discovery would leave no trace. This persists them (idempotent on
-- agent_instance_id + public_id), accumulating the operator's organically-grown
-- prospect list and seeding the future watchlist-compounding follow-up.
--
-- Keyed by public_id (the slug), since profile-search short mode usually doesn't
-- return an fsd_profile_id (nullable here; filled when known).
create table if not exists noelle.linkedin_discovered_people (
  id                uuid primary key default gen_random_uuid(),
  org_id            uuid not null references noelle.organizations(id) on delete cascade,
  agent_instance_id uuid not null references noelle.agent_instances(id) on delete cascade,
  public_id         text not null,
  fsd_profile_id    text,
  name              text,
  headline          text,
  -- 'profile_search' (Feeder A) | 'post_search' (keyword-lane author gate).
  source            text not null default 'profile_search',
  -- How many times discovery has re-surfaced this person (a popularity signal).
  seen_count        integer not null default 1,
  first_seen_at     timestamptz not null default now(),
  last_seen_at      timestamptz not null default now(),
  created_at        timestamptz not null default now(),
  unique (agent_instance_id, public_id)
);

create index if not exists linkedin_discovered_people_instance_idx
  on noelle.linkedin_discovered_people (agent_instance_id, last_seen_at desc);
