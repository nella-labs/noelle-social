-- infra/cloudsql/schema/0003_x_watchlist.sql
-- Watchlist of X handles + keywords the discovery worker scans per agent
-- instance. See docs/superpowers/specs/2026-05-18-x-intern-worker-pool-design.md
-- § 3.5. Tenancy: every row carries (org_id, agent_instance_id); the
-- discovery worker scopes its read by (agent_instance_id) since it acts on
-- behalf of one instance at a time.

create table if not exists noelle.x_watchlist (
  id                uuid          primary key default gen_random_uuid(),
  org_id            uuid          not null references noelle.organizations(id) on delete cascade,
  agent_instance_id uuid          not null references noelle.agent_instances(id) on delete cascade,
  kind              text          not null check (kind in ('handle', 'keyword')),
  value             text          not null,
  created_at        timestamptz   not null default now(),
  unique (agent_instance_id, kind, value)
);

create index if not exists x_watchlist_instance_idx
  on noelle.x_watchlist (agent_instance_id);

grant select, insert, update, delete on noelle.x_watchlist to noelle_app;

-- Send worker tracks which drafts have been actually posted on X. Without
-- this column the send loop has no idempotency anchor and would double-post
-- on retry. See plan Task 25.
alter table noelle.drafts
  add column if not exists sent_external_id text,
  add column if not exists posted_at timestamptz;

create index if not exists drafts_sent_pending_idx
  on noelle.drafts (sent_at)
  where sent_at is not null and sent_external_id is null;
