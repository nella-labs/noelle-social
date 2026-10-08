-- infra/cloudsql/schema/0023_persons_crm.sql
-- Contacts CRM: promote "people" to a first-class, org-scoped entity that can
-- hold MULTIPLE social accounts (X today; LinkedIn + Reddit are UI placeholders
-- until those integrations ship). Until now a "person" only existed as a
-- noelle.x_watchlist_people row — per agent_instance, X-handle only, reachable
-- only under the agent. This makes the person the root and links the watchlist
-- row to it.
--
-- Tenancy: every row carries org_id. There is no RLS in Cloud SQL — the app
-- layer (packages/runtime/src/tenancy.ts assertOrgMember) gates every read.
-- See docs/database-contract.md.

-- A person/contact in an org. display_name is free-text (falls back to the X
-- handle at backfill); notes is the CRM "more info" scratchpad.
create table if not exists noelle.persons (
  id           uuid        primary key default gen_random_uuid(),
  org_id       uuid        not null references noelle.organizations(id) on delete cascade,
  display_name text,
  notes        text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create index if not exists persons_org_idx on noelle.persons (org_id);

-- One social account per (platform) a person is reachable on. handle is the
-- @-stripped, lowercased username (x, reddit); url is the canonical profile
-- link (linkedin uses url, x/reddit derive it). One account per (org, platform,
-- handle) prevents duplicates across the org.
create table if not exists noelle.person_social_accounts (
  id         uuid        primary key default gen_random_uuid(),
  org_id     uuid        not null references noelle.organizations(id) on delete cascade,
  person_id  uuid        not null references noelle.persons(id) on delete cascade,
  platform   text        not null check (platform in ('x', 'linkedin', 'reddit')),
  handle     text,                                  -- @-stripped, lowercased (x/reddit)
  url        text,                                  -- canonical profile url (linkedin)
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (handle is not null or url is not null)
);

create index if not exists person_social_accounts_person_idx
  on noelle.person_social_accounts (person_id);

-- Dedupe handle-based accounts (x/reddit) across the org. linkedin (url-only)
-- rows are excluded from the constraint; they dedupe on nothing for now.
create unique index if not exists person_social_accounts_org_platform_handle_idx
  on noelle.person_social_accounts (org_id, platform, lower(handle))
  where handle is not null;

-- Link the always-reply watchlist row to its canonical person.
alter table noelle.x_watchlist_people
  add column if not exists person_id uuid references noelle.persons(id) on delete set null;

create index if not exists x_watchlist_people_person_idx
  on noelle.x_watchlist_people (person_id);

-- ── Backfill ────────────────────────────────────────────────────────────────
-- One person + one 'x' account per distinct (org_id, handle) among existing
-- watchlist people, then point x_watchlist_people.person_id at it. Idempotent:
-- only seeds handles that don't already have an 'x' account, so re-running is a
-- no-op.
with todo as (
  select distinct wp.org_id, lower(wp.handle) as handle
  from noelle.x_watchlist_people wp
  where not exists (
    select 1 from noelle.person_social_accounts a
    where a.org_id = wp.org_id
      and a.platform = 'x'
      and lower(a.handle) = lower(wp.handle)
  )
),
new_persons as (
  insert into noelle.persons (org_id, display_name)
  select org_id, handle from todo
  returning id, org_id, display_name
),
new_accounts as (
  insert into noelle.person_social_accounts (org_id, person_id, platform, handle)
  select np.org_id, np.id, 'x', np.display_name
  from new_persons np
  returning person_id, org_id, lower(handle) as handle
)
update noelle.x_watchlist_people wp
set person_id = na.person_id
from new_accounts na
where wp.org_id = na.org_id and lower(wp.handle) = na.handle;

-- Link any watchlist rows that still lack a person_id to an already-existing
-- 'x' account (covers re-runs and rows added between migration steps).
update noelle.x_watchlist_people wp
set person_id = a.person_id
from noelle.person_social_accounts a
where wp.person_id is null
  and a.org_id = wp.org_id
  and a.platform = 'x'
  and lower(a.handle) = lower(wp.handle);

grant select, insert, update, delete on noelle.persons               to noelle_app;
grant select, insert, update, delete on noelle.person_social_accounts to noelle_app;
