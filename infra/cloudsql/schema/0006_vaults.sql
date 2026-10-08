-- Multi-tenant Mars vault tables. Every Noelle org gets one row in
-- `noelle.vaults` that maps:
--
--   org_id  →  nella_workspace_id   (where Nella stores the search index)
--           →  storage_bucket+prefix (where the raw files live in GCS,
--                                    e.g. gs://noelle-vaults/<prefix>/)
--
-- Social channel retrieval goes through
-- `packages/runtime/src/vaultResolver.ts`, which reads this row and calls
-- Nella with the resolved workspace id. Each organization owns its retrieval
-- configuration, so tenants remain isolated without code changes.
--
-- Idempotent: every object uses `if not exists` / `drop trigger ... ; create`.
-- See `infra/cloudsql/README.md` for the apply procedure.

-- ---------------------------------------------------------------------------
-- noelle.vaults — one row per org.
--
-- Why `org_id` is UNIQUE (and not just FK):
--   In 0.0.1 we want exactly one vault per org. If we ever support multiple
--   vaults per org (e.g. one per team), drop the UNIQUE and add a second
--   identifier column. Until then, one-per-org is enforced here so the
--   resolver can `limit 1` and trust it.
-- ---------------------------------------------------------------------------
create table if not exists noelle.vaults (
  id                   uuid primary key default gen_random_uuid(),
  org_id               uuid not null unique references noelle.organizations(id) on delete cascade,
  nella_workspace_id   text not null,
  storage_bucket       text not null default 'noelle-vaults',
  storage_prefix       text not null,
  status               text not null default 'active',
  last_synced_at       timestamptz,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  constraint vaults_status_check
    check (status in ('provisioning', 'active', 'paused', 'errored'))
);

create index if not exists vaults_workspace_idx on noelle.vaults (nella_workspace_id);

drop trigger if exists vaults_set_updated_at on noelle.vaults;
create trigger vaults_set_updated_at
  before update on noelle.vaults
  for each row execute function noelle.tg_set_updated_at();

-- ---------------------------------------------------------------------------
-- noelle.vault_anchor_usage — append-only log of which anchors each draft
-- pulled. The dashboard "anchors used today" panel reads from this so it
-- can render without round-tripping to Nella, and it gives us a paper
-- trail for "why did this draft sound this way".
--
-- draft_id is nullable so the row survives a draft deletion (cascade was
-- considered; we chose set null so the audit history stays).
-- ---------------------------------------------------------------------------
create table if not exists noelle.vault_anchor_usage (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references noelle.organizations(id) on delete cascade,
  draft_id     uuid references noelle.drafts(id) on delete set null,
  agent_role   text not null,
  anchor_paths text[] not null,
  created_at   timestamptz not null default now()
);

create index if not exists vault_anchor_usage_org_created_idx
  on noelle.vault_anchor_usage (org_id, created_at desc);
create index if not exists vault_anchor_usage_draft_idx
  on noelle.vault_anchor_usage (draft_id);

-- ---------------------------------------------------------------------------
-- Grants — match the rest of noelle.* (noelle_app gets CRUD; DDL stays
-- with cloudsqlsuperuser). The default-privileges block in 0001 already
-- covers future tables in this schema, but we keep an explicit grant here
-- so re-applying this file on a fresh DB without 0001 is still safe.
-- ---------------------------------------------------------------------------
grant select, insert, update, delete on noelle.vaults              to noelle_app;
grant select, insert, update, delete on noelle.vault_anchor_usage to noelle_app;
