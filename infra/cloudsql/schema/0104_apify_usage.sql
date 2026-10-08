-- infra/cloudsql/schema/0104_apify_usage.sql
-- Provider-authoritative Apify usage snapshots. These rows preserve the actual
-- account balance returned by Apify even if a token is later invalidated or
-- removed from noelle.connections.

create table if not exists noelle.apify_usage_snapshots (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null,
  credential_id   uuid not null,
  label           text not null,
  account_id      text not null check (length(trim(account_id)) > 0),
  cycle_start_at  timestamptz not null,
  cycle_end_at    timestamptz not null,
  usage_usd       numeric not null check (usage_usd >= 0),
  max_usage_usd   numeric check (max_usage_usd is null or max_usage_usd >= 0),
  remaining_usd   numeric check (remaining_usd is null or remaining_usd >= 0),
  fetched_at      timestamptz not null,
  daily_usage     jsonb not null default '[]'::jsonb check (jsonb_typeof(daily_usage) = 'array'),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint apify_usage_snapshots_cycle_order
    check (cycle_start_at < cycle_end_at),
  constraint apify_usage_snapshots_credential_cycle_key
    unique (org_id, credential_id, cycle_start_at)
);

create index if not exists apify_usage_snapshots_account_cycle_idx
  on noelle.apify_usage_snapshots (org_id, account_id, cycle_start_at);

create index if not exists apify_usage_snapshots_org_cycle_idx
  on noelle.apify_usage_snapshots (org_id, cycle_start_at desc, fetched_at desc);

grant select, insert, update, delete on noelle.apify_usage_snapshots to noelle_app;
