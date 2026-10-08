-- Noelle base schema (Cloud SQL Postgres 16 in project noelle-agents).
--
-- Source of truth in 0.0.1; the Supabase migrations under
-- supabase/migrations/0001..0006 are deprecated once cutover (Phase 4 of
-- tasks/supabase-to-gcp-migration.md) completes. We keep them in-tree for
-- the dual-write window in case rollback is needed.
--
-- Differences vs. the Supabase schema:
--   1. No FKs to auth.users — `auth` lives in Supabase, this DB is data-only.
--      Columns that referenced auth.users (org_members.user_id,
--      approvals.decided_by) are plain uuid with NO foreign key.
--   2. No RLS policies. `auth.uid()` doesn't exist here. Tenancy lives in
--      app code (see packages/runtime/src/tenancy.ts).
--   3. No pg_cron / pg_net. Periodic work moves to Cloud Scheduler →
--      Cloud Run jobs (Phase 5 of the migration plan).
--   4. No `noelle.is_org_member()` SECURITY DEFINER helper — same reason as
--      RLS removal.
--   5. The `synced_*` table names from Supabase 0001 are already collapsed
--      into `leads` / `drafts` per migration 0004 — we ship the post-rename
--      shape here.

create schema if not exists noelle;
create extension if not exists "pgcrypto" with schema public;

-- ---------------------------------------------------------------------------
-- Updated-at trigger helper
-- ---------------------------------------------------------------------------
create or replace function noelle.tg_set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- organizations — tenant root
-- ---------------------------------------------------------------------------
create table noelle.organizations (
  id          uuid primary key default gen_random_uuid(),
  slug        text not null unique,
  name        text not null,
  plan        text not null default 'alpha',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create trigger organizations_set_updated_at
  before update on noelle.organizations
  for each row execute function noelle.tg_set_updated_at();

-- ---------------------------------------------------------------------------
-- org_members — user ↔ org membership.
-- user_id holds the Supabase auth.users.id (the `sub` claim of the JWT). No
-- FK to auth.users — that table lives in a separate DB now. Validity is
-- enforced at the application boundary on every signed-in request.
-- ---------------------------------------------------------------------------
create table noelle.org_members (
  org_id      uuid not null references noelle.organizations(id) on delete cascade,
  user_id     uuid not null,
  role        text not null default 'member',
  created_at  timestamptz not null default now(),
  primary key (org_id, user_id)
);

create index org_members_user_idx on noelle.org_members (user_id);

-- ---------------------------------------------------------------------------
-- agent_instances — one hired agent in one org
-- ---------------------------------------------------------------------------
create table noelle.agent_instances (
  id                uuid primary key default gen_random_uuid(),
  org_id            uuid not null references noelle.organizations(id) on delete cascade,
  role              text not null,
  status            text not null default 'active',
  display_name      text,
  model_overrides   jsonb not null default '{}'::jsonb,
  budget_cap_cents  integer,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  constraint agent_instances_org_role_unique unique (org_id, role)
);

create index agent_instances_org_idx on noelle.agent_instances (org_id);

create trigger agent_instances_set_updated_at
  before update on noelle.agent_instances
  for each row execute function noelle.tg_set_updated_at();

-- ---------------------------------------------------------------------------
-- leads — discovered source posts (today: X tweets). external_id holds the
-- source-platform record id so the discovery worker can dedupe.
-- ---------------------------------------------------------------------------
create table noelle.leads (
  id           uuid primary key default gen_random_uuid(),
  external_id  text not null unique,
  org_id       uuid not null references noelle.organizations(id) on delete cascade,
  payload      jsonb not null,
  synced_at    timestamptz not null default now()
);

create index leads_org_idx    on noelle.leads (org_id);
create index leads_synced_idx on noelle.leads (synced_at desc);

-- ---------------------------------------------------------------------------
-- drafts — agent-generated draft replies. One lead can have multiple drafts
-- (different angles / variants).
-- ---------------------------------------------------------------------------
create table noelle.drafts (
  id         uuid primary key default gen_random_uuid(),
  lead_id    uuid not null references noelle.leads(id) on delete cascade,
  org_id     uuid not null references noelle.organizations(id) on delete cascade,
  payload    jsonb not null,
  synced_at  timestamptz not null default now()
);

create index drafts_org_idx     on noelle.drafts (org_id);
create index drafts_lead_id_idx on noelle.drafts (lead_id);
create index drafts_synced_idx  on noelle.drafts (synced_at desc);

-- ---------------------------------------------------------------------------
-- approvals — one row per draft awaiting human review.
-- decided_by is `text`, not uuid: it holds the Supabase auth.users.id (a uuid
-- string) for human decisions AND the literal sentinel 'auto-send' for rows
-- the send worker auto-posts (see apps/x-intern/src/lib/send-db.ts and the
-- partial index in 0015_auto_send.sql). No FK either way.
-- ---------------------------------------------------------------------------
create table noelle.approvals (
  id                 uuid primary key default gen_random_uuid(),
  org_id             uuid not null references noelle.organizations(id) on delete cascade,
  agent_instance_id  uuid not null references noelle.agent_instances(id) on delete cascade,
  draft_id           uuid not null unique references noelle.drafts(id) on delete cascade,
  lead_id            uuid not null references noelle.leads(id) on delete cascade,
  status             text not null default 'pending',
  decided_at         timestamptz,
  decided_by         text,
  skip_reason        text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create index approvals_org_status_idx on noelle.approvals (org_id, status);
create index approvals_instance_idx   on noelle.approvals (agent_instance_id);
create index approvals_created_idx    on noelle.approvals (created_at desc);

create trigger approvals_set_updated_at
  before update on noelle.approvals
  for each row execute function noelle.tg_set_updated_at();

-- ---------------------------------------------------------------------------
-- org_spend_month — monthly rollup populated by Cloud Run job (Phase 5).
-- ---------------------------------------------------------------------------
create table noelle.org_spend_month (
  org_id      uuid not null references noelle.organizations(id) on delete cascade,
  month       date not null,
  bucket      text not null,
  cents       bigint not null default 0,
  updated_at  timestamptz not null default now(),
  primary key (org_id, month, bucket)
);

create index org_spend_month_month_idx on noelle.org_spend_month (month desc);

-- ---------------------------------------------------------------------------
-- worker_runs — operational heartbeat for the noelle-vm-0 worker pools
-- (discovery / classifier / drafter / send). Replaces the Supabase-era
-- sync_runs table that tracked openclaw mirror jobs.
-- ---------------------------------------------------------------------------
create table noelle.worker_runs (
  id             uuid primary key default gen_random_uuid(),
  worker         text not null,   -- 'discovery' | 'classifier' | 'drafter' | 'send'
  started_at     timestamptz not null default now(),
  finished_at    timestamptz,
  rows_processed integer,
  error          text
);

create index worker_runs_worker_started_idx on noelle.worker_runs (worker, started_at desc);

-- ---------------------------------------------------------------------------
-- llm_calls — per-LLM-invocation log; rolled up into org_spend_month by the
-- spend-rollup Cloud Run job (Phase 5).
-- ---------------------------------------------------------------------------
create table noelle.llm_calls (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references noelle.organizations(id) on delete cascade,
  agent_role   text not null,
  worker       text not null,
  engine       text not null,    -- 'vertex' | 'bedrock' | 'claude'
  model        text not null,
  bucket       text not null,    -- spend bucket: 'drafter' | 'classifier' | ...
  input_tokens integer,
  output_tokens integer,
  cents        integer not null default 0,
  latency_ms   integer,
  status       text not null default 'ok',
  started_at   timestamptz not null default now()
);
