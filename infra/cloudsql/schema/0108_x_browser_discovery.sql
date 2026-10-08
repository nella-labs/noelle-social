-- Browser-led X discovery uses only the actor's existing navigation slots.
alter table noelle.x_watchlist_people
  add column if not exists last_checked_at timestamptz,
  add column if not exists latest_observed_post_at timestamptz,
  add column if not exists latest_observed_tweet_id text;

alter table noelle.x_watchlist
  add column if not exists last_checked_at timestamptz,
  add column if not exists latest_observed_post_at timestamptz,
  add column if not exists latest_observed_tweet_id text;

create table if not exists noelle.x_discovery_schedule (
  agent_instance_id uuid primary key references noelle.agent_instances(id) on delete cascade,
  org_id uuid not null references noelle.organizations(id) on delete cascade,
  slot_count bigint not null default 0,
  updated_at timestamptz not null default now()
);
grant select, insert, update on noelle.x_discovery_schedule to noelle_app;

-- A lost reply acknowledgment cannot re-enable a second browser post.
create table if not exists noelle.x_reply_claims (
  org_id uuid not null references noelle.organizations(id) on delete cascade,
  tweet_id text not null check (tweet_id ~ '^[0-9]+$'),
  approval_id uuid not null,
  claimed_at timestamptz not null default now(),
  primary key (org_id, tweet_id)
);
create index if not exists x_reply_claims_approval_idx
  on noelle.x_reply_claims (org_id, approval_id);
grant select, insert on noelle.x_reply_claims to noelle_app;
