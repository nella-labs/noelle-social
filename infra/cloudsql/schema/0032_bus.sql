-- infra/cloudsql/schema/0032_bus.sql
-- Shared memory bus: a Postgres-backed store any agent/worker writes to and
-- reads from at any moment, so every agent knows what is happening org-wide.
-- Today agents coordinate ONLY through noelle.leads.status transitions; there
-- is no event stream and no "what is each worker doing right now" store. This
-- adds two shapes:
--
--   1. noelle.bus_events  — an append-only activity STREAM. "agent X did /
--      observed Y at time Z." Generalizes the worker_runs + llm_calls +
--      approvals union the activity feed already stitches together.
--   2. noelle.bus_state   — current-value KV "buckets". "the latest state of
--      namespace B is V." Any agent reads the freshest value at any moment.
--
-- "bucket" here is a KV NAMESPACE and is unrelated to the budget spend bucket
-- (packages/runtime/src/budgetBucket.ts, noelle.llm_calls.bucket). See
-- docs/shared-memory-bus.md.
--
-- Tenancy: every row carries org_id. There is no RLS in Cloud SQL — the app
-- layer (packages/runtime/src/tenancy.ts assertOrgMember) gates every read.
-- Writes are fail-soft telemetry from the workers (createBus in
-- packages/runtime/src/bus.ts never throws). See docs/database-contract.md.

-- ── Event stream ─────────────────────────────────────────────────────────────
-- Append-only. agent_instance_id is nullable (org-level events) and uses
-- `on delete set null` rather than cascade: events are an audit log and must
-- survive an instance being deleted. topic is a dotted verb-phrase
-- ('worker.tick', 'lead.classified', 'draft.sent', 'worker.error'); summary is
-- the human one-liner for the activity feed; payload carries structured detail
-- (lead_id, tier, counts, urls); correlation_id chains a lead's journey.
create table if not exists noelle.bus_events (
  id                uuid        primary key default gen_random_uuid(),
  org_id            uuid        not null references noelle.organizations(id) on delete cascade,
  agent_instance_id uuid        references noelle.agent_instances(id) on delete set null,
  agent_role        text        not null,                       -- 'x_intern' | 'linkedin_intern' | 'ceo' | 'cmo' | 'system'
  worker            text,                                       -- 'discovery' | 'classifier' | 'drafter' | 'send' | 'profiler' | null
  topic             text        not null,
  severity          text        not null default 'info' check (severity in ('info', 'warn', 'error')),
  summary           text,
  payload           jsonb       not null default '{}'::jsonb,
  correlation_id    text,
  created_at        timestamptz not null default now()
);

create index if not exists bus_events_org_created_idx
  on noelle.bus_events (org_id, created_at desc);
create index if not exists bus_events_org_instance_created_idx
  on noelle.bus_events (org_id, agent_instance_id, created_at desc);
create index if not exists bus_events_org_topic_created_idx
  on noelle.bus_events (org_id, topic, created_at desc);
create index if not exists bus_events_correlation_idx
  on noelle.bus_events (correlation_id);

-- ── Current-value KV "buckets" ───────────────────────────────────────────────
-- Upsert on (org_id, bucket, key); each write bumps version. value is opaque
-- jsonb. expires_at is an optional TTL — readers filter out expired rows (lazy
-- expiry; no sweeper in 0.0.1). updated_by_* records the last writer for the
-- orchestration view. version is bigint → postgres.js returns it as a STRING,
-- so the runtime client coerces with Number() on read (queries.ts:761 gotcha).
create table if not exists noelle.bus_state (
  org_id                 uuid        not null references noelle.organizations(id) on delete cascade,
  bucket                 text        not null,
  key                    text        not null,
  value                  jsonb       not null,
  version                bigint      not null default 1,
  updated_by_instance_id uuid        references noelle.agent_instances(id) on delete set null,
  updated_by_worker      text,
  expires_at             timestamptz,
  updated_at             timestamptz not null default now(),
  primary key (org_id, bucket, key)
);

create index if not exists bus_state_org_bucket_idx
  on noelle.bus_state (org_id, bucket);

create trigger bus_state_set_updated_at
  before update on noelle.bus_state
  for each row execute function noelle.tg_set_updated_at();

-- schema_migrations is created before 0001's `alter default privileges`, so new
-- tables don't auto-grant to noelle_app. Grant explicitly (every recent
-- migration does the same — see migrate.ts:109).
grant select, insert, update, delete on noelle.bus_events to noelle_app;
grant select, insert, update, delete on noelle.bus_state  to noelle_app;
