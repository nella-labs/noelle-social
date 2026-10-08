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

```sql
create table noelle.leads (
  id                 uuid         primary key default gen_random_uuid(),
  org_id             uuid         not null references noelle.organizations(id) on delete cascade,
  agent_instance_id  uuid         not null references noelle.agent_instances(id) on delete cascade,
  external_id        text         not null,
  platform           text         not null
                       check (platform in ('x', 'linkedin', 'reddit')),
  author_handle      text         not null,
  author_id          text         null,
  payload            jsonb        not null,
  tier               text         null
                       check (tier in ('T1', 'T2', 'T3') or tier is null),
  status             text         not null default 'new'
                       check (status in ('new', 'classified', 'drafting', 'drafted', 'sent', 'skipped', 'errored')),
  classifier_label   text         null,
  classifier_score   numeric(5,4) null,
  vip_signal         jsonb        null,  -- 0071: relationship-scout verdict {vip, reason, tags[], add_to_watchlist, dm_soon, suggested_dm}; NULL = scout never ran. See @noelle/contracts VipSignalSchema.
  priority           boolean      not null default false,  -- always-reply (x_watchlist_people); bypasses classifier + drafter filters
  posted_at          timestamptz  null,
  claimed_at         timestamptz  null,
  created_at         timestamptz  not null default now(),
  updated_at         timestamptz  not null default now(),

  unique (external_id)   -- single-column; upsertDiscoveredLead relies on `on conflict (external_id)`
);

create index leads_org_status_idx on noelle.leads (org_id, status, created_at desc);
create index leads_status_claimable_idx on noelle.leads (status) where status in ('new', 'classified');
create index leads_payload_gin_idx on noelle.leads using gin (payload jsonb_path_ops);

create trigger tg_leads_updated_at
  before update on noelle.leads
  for each row execute function noelle.tg_set_updated_at();
```

**Mid-claim statuses are leased, not owned.** `classifying` and `drafting` are
transient claim states: the claim RPCs flip into them and the worker writes the
terminal outcome, but a worker crash/restart between the two would strand the
lead (claims only pick the pre-claim status). Every classifier/drafter tick
therefore starts with `reapStaleClaims` (each intern's `lib/leads-db.ts`):
claims stranded longer than 45 minutes are returned to their pre-claim status
(`classifying`→`new`, `drafting`→`classified`), and strands older than 48 hours
are expired to `skipped` with a `payload.stale_claim = "expired"` marker (a
reply to a two-day-old post reads as necro-engagement). Anything that adds a new
claim state must add it to the reaper.

---

### 2.5 `noelle.drafts`

The drafts produced by the drafter worker — one row per variant. Per lead the drafter emits three `kind='reply'` angle variants (empathetic / technical / contrarian) **plus one `kind='dm'`** cold-outreach DM. A DM has no angle (`angle=null`); it is manual-send (the founder copies it and sends it on X by hand, then marks the approval sent). The send worker never posts a `kind='dm'` row to X.

```sql
create table noelle.drafts (
  id                 uuid         primary key default gen_random_uuid(),
  org_id             uuid         not null references noelle.organizations(id) on delete cascade,
  agent_instance_id  uuid         not null references noelle.agent_instances(id) on delete cascade,
  lead_id            uuid         not null references noelle.leads(id) on delete cascade,
  kind               text         not null
                       check (kind in ('reply', 'dm', 'repost')),
  angle              text         null  -- null for kind='dm' (a DM has no angle)
                       check (angle is null or angle in ('empathetic', 'technical', 'contrarian')),
  body               text         not null,
  final_body         text         null,
  char_count         integer      not null,
  source_engine      text         not null,
  model              text         null,
  quality_score      numeric(5,4) null,
  quality_passed     boolean      null,
  sent_at            timestamptz  null,
  created_at         timestamptz  not null default now(),
  updated_at         timestamptz  not null default now()
);

create index drafts_lead_id_idx on noelle.drafts (lead_id);
create index drafts_org_created_at_idx on noelle.drafts (org_id, created_at desc);

create trigger tg_drafts_updated_at
  before update on noelle.drafts
  for each row execute function noelle.tg_set_updated_at();
```

---

### 2.6 `noelle.approvals`

The approvals inbox. Hono inserts the row when the drafter posts `POST /api/outbound`; Hono updates `status` when the user clicks "send" or "skip". `actioned_by` (formerly `decided_by` in some drafts) is a plain uuid — the Supabase user id of the actor — **no FK to `auth.users`**.

```sql
create table noelle.approvals (
  id                 uuid         primary key default gen_random_uuid(),
  org_id             uuid         not null references noelle.organizations(id) on delete cascade,
  agent_instance_id  uuid         not null references noelle.agent_instances(id) on delete cascade,
  lead_id            uuid         not null references noelle.leads(id) on delete cascade,
  draft_ids          uuid[]       not null,
  sent_draft_id      uuid         null references noelle.drafts(id) on delete set null,
  status             text         not null default 'pending'
                       check (status in ('pending', 'sent', 'skipped', 'errored')),
  tier               text         null,
  quality_score      numeric(5,4) null,
  quality_passed     boolean      null,
  skip_reason        text         null,
  skip_note          text         null,
  actioned_by        uuid         null,    -- Supabase user id; no FK
  sent_at            timestamptz  null,
  skipped_at         timestamptz  null,
  created_at         timestamptz  not null default now(),
  updated_at         timestamptz  not null default now(),

  constraint approvals_lead_unique unique (lead_id),
  constraint approvals_decided_pair check (
    (status = 'pending'  and sent_at is null and skipped_at is null)
    or (status = 'sent'  and sent_at is not null)
    or (status = 'skipped' and skipped_at is not null)
    or status = 'errored'
  )
);

create index approvals_org_status_created_at_idx
  on noelle.approvals (org_id, status, created_at desc);

create index approvals_agent_instance_id_idx
  on noelle.approvals (agent_instance_id);

create trigger tg_approvals_updated_at
  before update on noelle.approvals
  for each row execute function noelle.tg_set_updated_at();
```

---

### 2.7 `noelle.llm_calls`

Per-call cost telemetry. Every `callAgentModel` writes one row here. Drives the 5-min spend rollup.

```sql
create table noelle.llm_calls (
  id                 bigserial    primary key,
  org_id             uuid         not null references noelle.organizations(id) on delete cascade,
  agent_instance_id  uuid         not null references noelle.agent_instances(id) on delete cascade,
  bucket             text         not null,
  engine             text         not null,
  model              text         not null,
  input_tokens       integer      not null default 0,
  output_tokens      integer      not null default 0,
  cost_cents         integer      not null default 0,
  latency_ms         integer      not null default 0,
  outcome            text         not null
                       check (outcome in ('ok', 'fallback_to_vertex', 'fallback_to_bedrock', 'fallback_to_claude', 'error')),
  created_at         timestamptz  not null default now()
);

create index llm_calls_org_bucket_created_at_idx
  on noelle.llm_calls (org_id, bucket, created_at desc);

create index llm_calls_org_month_idx
  on noelle.llm_calls (org_id, date_trunc('month', created_at));
```

---

### 2.8 `noelle.org_spend_month`

Monthly per-bucket spend rollup. Refreshed every 5 min by the Vercel cron.

```sql
create table noelle.org_spend_month (
  org_id      uuid         not null references noelle.organizations(id) on delete cascade,
  month       date         not null,
  bucket      text         not null,
  cents       integer      not null default 0 check (cents >= 0),
  updated_at  timestamptz  not null default now(),
  primary key (org_id, month, bucket)
);

create trigger tg_org_spend_month_updated_at
  before update on noelle.org_spend_month
  for each row execute function noelle.tg_set_updated_at();
```

---

### 2.9 `noelle.worker_runs`

Operational telemetry for the workers on `noelle-vm-0`.

```sql
create table noelle.worker_runs (
  id              bigserial    primary key,
  kind            text         not null
                    check (kind in ('discovery', 'classifier', 'drafter', 'send', 'spend_rollup')),
  started_at      timestamptz  not null default now(),
  finished_at     timestamptz  null,
  status          text         not null default 'running'
                    check (status in ('running', 'ok', 'error')),
  rows_processed  integer      not null default 0 check (rows_processed >= 0),
  error_message   text         null
);

create index worker_runs_kind_finished_at_idx
  on noelle.worker_runs (kind, finished_at desc nulls last);
```

---

### 2.10 `noelle.video_recording_briefs`

Added by migration `0080_video_recording_briefs.sql`. One phone-readable **recording brief** per operator-approved video draft, produced by Nova's sixth worker, the **`briefer`** (the "media intern"). The briefer claims `video_drafts` with `status='ready'` that have no brief yet, generates a structured brief through the same text seam as the scripter, renders it to markdown, and writes one row here. It only reads `ready` drafts and writes this table — it never mutates the ideas→drafts pipeline.

Key columns: `draft_id` (**unique**, FK → `video_drafts` on delete cascade — one brief per draft; a manual regenerate overwrites), `idea_id`, `platform`, `runtime_target` (seconds), `brief` (jsonb — the structured `RecordingBriefOutput`), `brief_md` (the ≤600-word markdown), `forge_followups` (int, the count of on-the-day notes flagged `forgeWouldHelp` — computed deterministically by the tick, not the model), `source_engine`/`model`, `status` (default `ready`). Indexes: `(agent_instance_id, created_at desc)` + the unique `draft_id`. `grant … to noelle_app`; `tg_set_updated_at` trigger.

Gated by the `NOELLE_BRIEFER` flag (default **OFF**): the table exists but stays empty until the briefer worker is enabled. Supersedes the never-deployed Paperclip `media-intern`.

---

### 2.11 `noelle.work_queue`

Added by migration `0087_work_queue.sql`. The durable job queue behind `PgWorkQueue` (`packages/runtime/src/queue.ts`) — the retry / dead-letter / orphan-reclaim primitive described in `docs/scalability.md` § Pluggable WorkQueue. One table serves every logical queue, discriminated by the `queue` column; jobs are an opaque `job jsonb` payload.

Key columns: `queue` (logical queue name), `seq` (identity — FIFO total order, tie-breaks `available_at` collisions), `job` (jsonb payload — always written via `($n::text)::jsonb` and read via `job::text`, see the double-encode note in queue.ts), `key` (optional idempotency key; partial unique index on `(queue, key)` makes a duplicate enqueue a no-op), `attempts` (incremented at claim), `available_at` (earliest next delivery), `claim_id` + `claimed_until` (the live claim token and its TTL — an expired claim makes the row claimable again, which is the orphan-reclaim path for workers that die mid-job), `dead_at` (dead-lettered: stamped by `nack` when attempts exhaust the queue's `maxAttempts`, or lazily by the next `claim()` for exhausted orphans that never got a nack). Claim hot path is served by the partial index `(queue, available_at, seq) where dead_at is null`.

Tenant scoping stays in app code, same as every table here: callers run `assertOrgMember` before enqueueing, and per-org claim fairness reads `job->>'org_id'` via `ClaimOptions.perKeyMax`. `grant select, insert, update, delete … to noelle_app`. As of 0087 no production worker enqueues into it yet — the existing per-table status-transition claims still run the pipeline; this is the primitive for moving them over.

---

## 3. Shared functions

### 3.1 `noelle.tg_set_updated_at()`

```sql
create or replace function noelle.tg_set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;
```

### 3.2 Lead claim RPC (today)

The drafter (and classifier) claim leads in batches using `FOR UPDATE SKIP LOCKED`. The function lives in the database for atomicity. Its return shape includes the `priority` column (added in `0018_x_watchlist_people.sql`, via DROP + CREATE since the return type changed) so the drafter can skip its relevance gate for watchlist leads:

```sql
create function noelle.claim_leads_for_drafting(
  p_agent_instance_id uuid,
  p_batch             integer
)
returns table (
  id                uuid,
  external_id       text,
  payload           jsonb,
  author_handle     text,
  author_id         text,
  tier              text,
  classifier_label  text,
  classifier_score  numeric,
  status            text,
  priority          boolean
)
language sql
as $$
  update noelle.leads
  set status = 'drafting', updated_at = now()
  where id in (
    select id from noelle.leads
    where agent_instance_id = p_agent_instance_id
      and status = 'classified'
    order by created_at asc
    for update skip locked
    limit p_batch
  )
  returning id, external_id, payload, author_handle, author_id, tier,
            classifier_label, classifier_score, status, priority;
$$;
```

Notes: parameter is `p_batch` (no default); it's `language sql` (not plpgsql) and scopes by `agent_instance_id` only (the instance is already org-bound). The `priority` column was added to the return list in `0018_x_watchlist_people.sql` via DROP + CREATE (return-type change). `security definer` was only useful when RLS was on; without RLS it's plain `security invoker`. Phase 5 replaces these claim functions with Pub/Sub subscriptions on `noelle.leads.classified`, `noelle.drafts.created`, etc.

**Reply freshness (`0088_reply_freshness_rpcs.sql`).** Both `claim_leads_for_drafting` and `claim_watchlist_leads_for_drafting` gained a **trailing `p_max_age_hours integer default null`** 3rd argument (DROP + CREATE — the return type is unchanged, but the arity is not). The default makes this backward-compatible: the existing **2-arg callers (Orion/reddit + Lyra/linkedin interns) resolve to the new function with `p_max_age_hours = null`** and keep byte-identical behavior, including the keyword lane's `created_at asc` ordering. Only Vega/x-intern passes the 3rd arg (`X_REPLY_MAX_AGE_HOURS`, default **25**): a set ceiling (a) drops candidate leads whose target tweet's own `payload->>'posted_at'` is older than the ceiling (fail-open on undateable posts) and (b) flips the keyword lane to **freshest-posted-first** — a reply account must serve live conversations before stale backlog; starvation of skipped-over leads is handled by the drafter's `expireStaleClassifiedLeads` sweep, not by oldest-first ordering. **Deploy order: apply 0088 BEFORE the x-intern code that passes the 3rd arg merges** (migrations are hand-applied first anyway — see § 6). The **drafter** (which always ticks, incl. paused instances) runs the same-ceiling `expireStaleApprovals` sweep (`lib/send-db.ts`) that flips aged-out pending/limbo reply approvals to the terminal `status='expired'`. The live reply path is the **browser actuator**, not the API send worker, so `apps/api-vm` `GET /api/actionable-x` reads the SAME `X_REPLY_MAX_AGE_HOURS` (default 25) and withholds any reply whose target tweet aged out — the definitive freshness gate at the actuation point.

---

## 4. App-layer tenancy (replaces RLS)

`packages/runtime/src/tenancy.ts` exports `assertOrgMember(client, { orgId, userId })`. Every server-side caller invokes it before touching `noelle.*`. The function:

1. Runs `select 1 from noelle.org_members where org_id = $orgId and user_id = $userId`.
2. Throws `OrgMembershipError` if the row is missing.

Callers:

- **`apps/app` server actions and RSC fetchers** — verify JWT in middleware → extract `sub` → `assertOrgMember` → query.
- **`apps/api-vm` Hono routes** — verify JWT (Supabase JWKS) → extract `sub` → `assertOrgMember` → query.
- **Worker pool on `noelle-vm-0`** — workers act on behalf of an agent instance, not a user. They use the (org_id, agent_instance_id) ownership invariant directly: a worker only ever queries rows with the (org_id, agent_instance_id) it was assigned at boot. There is no per-user tenancy check because workers aren't user-driven.

There is no fallback path. If `assertOrgMember` is skipped, the query still works at the DB level — that's the whole risk. CI tests in `apps/app` and `apps/api-vm` lint for the presence of `assertOrgMember` before any `noelle.*` query (see [testing.md](testing.md)).

---

## Migrations and initialization

Use the managed CLI's `migrate` command. It reads migrations in filename order and records applied filenames in `noelle.schema_migrations`. Keep historical filenames stable: a restored installation may already have them in its ledger.

Personal historical seed files remain as no-op ledger entries. A fresh `init` creates the configured operator and workspace, then four paused platform profiles with publication disabled. It does not seed personal contacts or management roles. Migration `0127` archives legacy management profiles without deleting their data.

Existing saved installations keep their configuration. Apply updates through the documented managed commands; do not run ad hoc seed SQL against a live installation.

## Runtime access

Use the installation's configured `NOELLE_DATABASE_URL`. Keep database credentials in its private runtime configuration, outside git. Remote PostgreSQL requires the hosting provider's network and TLS settings; no repository IP or project identifier provisions that access.

Back up the database and private installation configuration before restoration or destructive cleanup. A source checkout is not a database backup. See [the runbook](runbook.md) and [secrets](secrets.md).

## Related contracts

- [Architecture](architecture.md)
- [Social profile model](agent-model.md)
- [Vaults and retrieval](vault.md)
- [Disposable database testing](testing.md)
