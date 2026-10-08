# Database contract

The canonical schema and migration history live in `infra/cloudsql/schema/`. The table descriptions below explain the main data flow; later migrations add platform fields and constraints. Read the SQL for the exact current shape.

## Conventions

- Product tables use the `noelle` schema and UUID identifiers.
- PostgreSQL stores `timestamptz` values in UTC; the UI displays local time.
- Mutable tables use the shared updated-at trigger.
- The application role has product CRUD access; migrations use a separately configured administrator connection.
- Local operator identity and hosted Supabase sessions are supported authentication modes. Product membership records belong to the installation's database.
- App queries check organization membership before accessing tenant data. Workers resolve and scope their organization/profile/account explicitly. Direct PostgreSQL does not supply hosted `auth.uid()` semantics.

## 1. Extensions

```sql
create extension if not exists pgcrypto;     -- gen_random_uuid()
create extension if not exists pg_trgm;      -- text search on drafts payload
```

Optional hosted PostgreSQL extensions are not required by the native installation. Worker processes and managed runtime commands own scheduling.

---

## 2. Tables

### 2.1 `noelle.organizations`

A tenant. One row per customer org.

```sql
create table noelle.organizations (
  id          uuid          primary key default gen_random_uuid(),
  name        text          not null,
  slug        text          not null unique,
  plan        text          not null default 'alpha'
                check (plan in ('alpha', 'starter', 'pro', 'enterprise')),
  created_at  timestamptz   not null default now(),
  updated_at  timestamptz   not null default now()
);

create trigger tg_organizations_updated_at
  before update on noelle.organizations
  for each row execute function noelle.tg_set_updated_at();
```

**Access.** Reads/writes gated by `assertOrgMember` in app code — see § 4.

---

### 2.2 `noelle.org_members`

Many-to-many between users and orgs, with a role. `user_id` is the Supabase Auth `sub` claim — a plain `uuid`, **no FK**.

```sql
create table noelle.org_members (
  org_id      uuid          not null references noelle.organizations(id) on delete cascade,
  user_id     uuid          not null,           -- Supabase Auth sub claim; no FK
  role        text          not null default 'member'
                check (role in ('owner', 'member')),
  created_at  timestamptz   not null default now(),
  primary key (org_id, user_id)
);

create index org_members_user_id_idx on noelle.org_members (user_id);
```

This is the table `assertOrgMember` queries. The check is: `select 1 from noelle.org_members where org_id = $1 and user_id = $2`.

---

### 2.3 `noelle.agent_instances`

One row per hired agent in an org. Drives the constellation view. 0.0.1 hires three per org (CEO, CMO, X intern). `created_by` is a plain uuid — the Supabase user that hired the agent, no FK.

```sql
create table noelle.agent_instances (
  id                 uuid         primary key default gen_random_uuid(),
  org_id             uuid         not null references noelle.organizations(id) on delete cascade,
  role               text         not null
                       check (role in ('ceo', 'cmo', 'x_intern')),
  status             text         not null default 'provisioning_alpha'
                       check (status in ('active', 'provisioning_alpha', 'paused', 'error')),
  model_overrides    jsonb        not null default '{}'::jsonb,
  budget_cap_cents   integer      not null default 10000
                       check (budget_cap_cents >= 0),
  display_name       text         not null,
  created_at         timestamptz  not null default now(),
  created_by         uuid         not null,    -- Supabase user id; no FK
  updated_at         timestamptz  not null default now(),

  constraint agent_instances_org_role_unique unique (org_id, role)
);

create index agent_instances_org_id_idx on noelle.agent_instances (org_id);

-- Migration-added columns (not in the base DDL above):
--   0027_last_goal_started_at.sql — last_goal_started_at timestamptz. Sticky copy
--     of goal_started_at, stamped on every goal-run start and never cleared (unlike
--     goal_started_at, which is nulled on auto-pause). Anchors the approvals inbox
--     "Last batch" filter.
--   0028_budget_cap_floor.sql — one-time data fix: raises any stored
--     budget_cap_cents in (0, 2500) up to the $25 (2500¢) UI/enforcement floor so
--     the config input, the "spent this month" line, and the runtime cap all agree.

create trigger tg_agent_instances_updated_at
  before update on noelle.agent_instances
  for each row execute function noelle.tg_set_updated_at();
```

**Layered columns (later migrations).** `agent_instances` carries per-agent config
added incrementally beyond the base table above: policy flags (`0010`),
backpressure caps (`0012`/`0013`), auto-send (`0015`), **tailored discovery
(`0032`)** — `discovery_config jsonb` (the saved default) + `run_config jsonb`
(the active per-run override, null when none) shaping which posts discovery
pulls (time window, posts-per-source, min-engagement, post-type filters);
validated against `DiscoveryConfigSchema` in `@noelle/contracts`, resolved
run-over-default-over-worker-defaults in `apps/x-intern` (`resolveDiscoveryConfig`).
`run_config` is stamped by "Start all → Tailor this run" and cleared on Stop all
+ goal auto-pause. And **`objective text` (`0017`)** — the operator's mission. `objective IS NULL` means "fall back to the
agent type's manifest `short_description`"; collapse the two with
`resolveObjective()` from `@noelle/runtime` (never read `objective` raw for
display or prompts). For the X intern the resolved objective steers the
classifier and drafter prompts (`buildClassifierSystem` / `buildDrafterSystem` in
`apps/x-intern`) when the operator has set a custom one. The *why* (mission)
lives here; the concrete *what it searches* (handles + keywords) lives in
`noelle.x_watchlist` (see `infra/cloudsql/schema/0003_x_watchlist.sql`).

A separate **always-reply watchlist** of *people* lives in
`noelle.x_watchlist_people` (see `infra/cloudsql/schema/0018_x_watchlist_people.sql`):

```sql
create table noelle.x_watchlist_people (
  id                uuid        primary key default gen_random_uuid(),
  org_id            uuid        not null references noelle.organizations(id) on delete cascade,
  agent_instance_id uuid        not null references noelle.agent_instances(id) on delete cascade,
  handle            text        not null,          -- @-stripped, lowercased
  added_at          timestamptz not null default now(),
  created_at        timestamptz not null default now(),
  unique (agent_instance_id, handle)
);
```

Unlike `x_watchlist`, posts from these people are **not** filtered: at discovery,
a post from one of these handles made on/after the person's `added_at` is flagged
`leads.priority = true` and bypasses both the classifier on-brand filter and the
drafter relevance gate, so every new post gets a drafted reply (still queued for
approval). Edited from the "Watchlist" card on the agent detail page.

#### Contacts CRM (`noelle.persons`, `noelle.person_social_accounts`)

The **Contacts** CRM (top-level `/app/[orgSlug]/contacts`) promotes a *person* to
a first-class, org-scoped entity that can hold multiple social accounts. A
watchlist row is per-agent and X-handle-only; a person is org-wide and
platform-agnostic. Added in `infra/cloudsql/schema/0023_persons_crm.sql`:

```sql
create table noelle.persons (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references noelle.organizations(id) on delete cascade,
  display_name text,          -- free-text; backfilled to the X handle
  notes        text,          -- CRM "more info" scratchpad
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create table noelle.person_social_accounts (
  id        uuid primary key default gen_random_uuid(),
  org_id    uuid not null references noelle.organizations(id) on delete cascade,
  person_id uuid not null references noelle.persons(id) on delete cascade,
  platform  text not null check (platform in ('x','linkedin','reddit')),
  handle    text,             -- @-stripped, lowercased (x/reddit)
  url       text,             -- canonical profile url (linkedin)
  check (handle is not null or url is not null)
);
-- unique (org_id, platform, lower(handle)) where handle is not null
```

`platform = 'x'` (Vega) and `platform = 'linkedin'` (Lyra) are both live; `reddit`
is reserved and renders as an inactive "coming soon" slot. A LinkedIn account
stores the vanity slug (`public_id`) in `handle` and the profile URL in `url`.

**Population is self-healing.** `reconcileContactsForOrg` (run on every contacts
load) idempotently materializes a person + account for: every `x_watchlist_people`
handle, every `linkedin_watchlist_people` `public_id`, and every author with a
`noelle.approvals.status = 'sent'` reply (keyed on the lead's `author_handle` +
`platform`). Pending/skipped drafts do **not** create a contact. The live UI
hooks `ensurePersonForHandle` (X) and `ensurePersonForLinkedIn` (LinkedIn) do the
same on watchlist-add so it's instant; the reconcile is the backstop that heals
rows seeded straight into a watchlist (bypassing those hooks).
`noelle.x_watchlist_people.person_id` links each X watchlist row to its person;
LinkedIn watchers match via the person's `linkedin` account (`public_id`).
Org-wide stats and interaction history key off the contact's handle (X handle /
LinkedIn `public_id`) against `noelle.leads.author_handle` / `noelle.approvals`.

---

### 2.4 `noelle.leads`

Raw lead rows produced by the discovery worker. Owned end-to-end by the X intern agent on `noelle-vm-0`.
