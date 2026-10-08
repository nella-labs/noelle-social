-- Durable Friendly DM requests created by the MCP tools. These rows are one-off
-- work orders; they do not enable the recurring relationship-DM lane.

create table if not exists noelle.relationship_dm_requests (
  id                uuid primary key default gen_random_uuid(),
  org_id            uuid not null references noelle.organizations(id) on delete cascade,
  agent_instance_id uuid not null references noelle.agent_instances(id) on delete cascade,
  platform          text not null check (platform in ('linkedin', 'x')),
  person_id         uuid references noelle.persons(id) on delete set null,
  recipient_key     text,
  author_id         text,
  requested_count   integer not null check (requested_count between 1 and 40),
  processed_count   integer not null default 0,
  queued_count      integer not null default 0,
  skipped_count     integer not null default 0,
  failed_count      integer not null default 0,
  status            text not null default 'pending'
                    check (status in ('pending', 'running', 'done', 'cancelled')),
  reason            text,
  created_by        text,
  created_at        timestamptz not null default now(),
  started_at        timestamptz,
  completed_at      timestamptz,
  updated_at        timestamptz not null default now()
);

create index if not exists relationship_dm_requests_pending_idx
  on noelle.relationship_dm_requests (org_id, agent_instance_id, platform, created_at)
  where status in ('pending', 'running');

alter table noelle.relationship_dm_reservations
  add column if not exists request_id uuid references noelle.relationship_dm_requests(id) on delete set null,
  add column if not exists judge_verdict jsonb;

create index if not exists relationship_dm_reservations_request_idx
  on noelle.relationship_dm_reservations (request_id)
  where request_id is not null;

create index if not exists leads_relationship_dm_key_idx
  on noelle.leads (org_id, platform, lower(regexp_replace(trim(coalesce(author_handle, '')), '^@+', '')), created_at desc)
  where author_handle is not null;

drop trigger if exists relationship_dm_requests_set_updated_at on noelle.relationship_dm_requests;
create trigger relationship_dm_requests_set_updated_at
  before update on noelle.relationship_dm_requests
  for each row execute function noelle.tg_set_updated_at();

grant select, insert, update, delete on noelle.relationship_dm_requests to noelle_app;
