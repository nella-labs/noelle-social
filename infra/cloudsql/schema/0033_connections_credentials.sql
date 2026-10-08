-- infra/cloudsql/schema/0033_connections_credentials.sql
-- DB-backed connections (hot-swappable API tokens) + per-token spend attribution.
--
-- Why a table (vs GCP Secret Manager / env): the operator sets the Apify token in
-- the dashboard, but the workers run as separate processes (on the VM). An env /
-- SM write never reaches a running worker without a restart, and there's nowhere
-- to attribute spend per token. A DB row solves both: the dashboard writes it, the
-- workers read the ACTIVE row each tick (true hot-swap), and llm_calls.credential_id
-- ties every Apify spend row to the token that paid for it.
--
-- History is preserved on rotation: submitting a new token INSERTs a new row and
-- flips it active (the partial unique index guarantees one active per org+kind);
-- old rows stay so their spend history survives. `secret` holds the token value
-- (self-host: local VM Postgres; managed: Cloud SQL at rest).

create table if not exists noelle.connections (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references noelle.organizations(id) on delete cascade,
  kind        text not null,                 -- 'apify' (extensible to other tokens)
  label       text not null,                 -- masked display label, e.g. 'apify_…a1b2'
  secret      text not null,                 -- the token value (read by workers)
  active      boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- At most one ACTIVE connection per (org, kind). Rotation deactivates the prior.
create unique index if not exists connections_one_active_per_kind
  on noelle.connections (org_id, kind) where active;

create index if not exists connections_org_kind_idx
  on noelle.connections (org_id, kind, created_at desc);

-- Tie each spend row to the credential that paid for it (null for LLM rows and
-- for Apify runs that used the env-fallback token). on delete set null so purging
-- an old token never deletes its spend history — it just unlinks.
alter table noelle.llm_calls
  add column if not exists credential_id uuid
    references noelle.connections(id) on delete set null;

create index if not exists llm_calls_credential_idx
  on noelle.llm_calls (credential_id, started_at desc);

-- Workers (noelle_app) read connections; the app reads+writes. New tables inherit
-- privileges from the 0003 `alter default privileges`, but grant explicitly too.
grant select, insert, update on noelle.connections to noelle_app;
