-- Browser-led discovery keeps navigation cadence and watchlist observations in SQL.
alter table noelle.linkedin_watchlist_people
  add column if not exists last_checked_at timestamptz,
  add column if not exists latest_observed_post_at timestamptz,
  add column if not exists latest_observed_urn text;

alter table noelle.linkedin_watchlist
  add column if not exists last_checked_at timestamptz;

create table if not exists noelle.linkedin_discovery_schedule (
  agent_instance_id uuid primary key references noelle.agent_instances(id) on delete cascade,
  org_id uuid not null references noelle.organizations(id) on delete cascade,
  slot_count bigint not null default 0,
  updated_at timestamptz not null default now()
);

grant select, insert, update on noelle.linkedin_discovery_schedule to noelle_app;
