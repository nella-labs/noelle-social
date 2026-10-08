-- infra/cloudsql/schema/0098_relationship_dm_reservations.sql
-- Conservative reservation ledger for proactive relationship DMs. Claims are
-- org/platform/day scoped in the operator's Bogota day; failed/skipped attempts
-- stay in the ledger so they consume that day's budget. A queued row suppresses
-- the recipient permanently, while a live reserved row suppresses until the
-- worker records queued/skipped/failed.

create table if not exists noelle.relationship_dm_reservations (
  id                uuid primary key default gen_random_uuid(),
  org_id            uuid not null references noelle.organizations(id) on delete cascade,
  agent_instance_id uuid not null references noelle.agent_instances(id) on delete cascade,
  platform          text not null check (platform in ('linkedin', 'x')),
  recipient_key     text not null,
  author_id         text,
  person_id         uuid references noelle.persons(id) on delete set null,
  recipient_name    text,
  profile_url       text,
  status            text not null default 'reserved'
                    check (status in ('reserved', 'queued', 'skipped', 'failed')),
  reason            text,
  reserved_for_date date not null,
  reserved_at       timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (org_id, platform, recipient_key, reserved_for_date)
);

create index if not exists relationship_dm_reservations_day_idx
  on noelle.relationship_dm_reservations (org_id, platform, reserved_for_date, status);

create unique index if not exists relationship_dm_reservations_active_key_idx
  on noelle.relationship_dm_reservations (org_id, platform, recipient_key)
  where status in ('reserved', 'queued');

create unique index if not exists relationship_dm_reservations_day_author_idx
  on noelle.relationship_dm_reservations (org_id, platform, author_id, reserved_for_date)
  where author_id is not null;

create unique index if not exists relationship_dm_reservations_day_person_idx
  on noelle.relationship_dm_reservations (org_id, person_id, reserved_for_date)
  where person_id is not null;

create unique index if not exists relationship_dm_reservations_active_author_idx
  on noelle.relationship_dm_reservations (org_id, platform, author_id)
  where author_id is not null and status in ('reserved', 'queued');

create unique index if not exists relationship_dm_reservations_active_person_idx
  on noelle.relationship_dm_reservations (org_id, person_id)
  where person_id is not null and status in ('reserved', 'queued');

drop trigger if exists relationship_dm_reservations_set_updated_at on noelle.relationship_dm_reservations;
create trigger relationship_dm_reservations_set_updated_at
  before update on noelle.relationship_dm_reservations
  for each row execute function noelle.tg_set_updated_at();

grant select, insert, update, delete on noelle.relationship_dm_reservations to noelle_app;
