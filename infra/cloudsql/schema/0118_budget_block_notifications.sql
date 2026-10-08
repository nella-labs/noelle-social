-- A cap-block event is separate from a successful operator notification.
-- Keep one accepted receipt per organization and configured calendar window.
create table if not exists noelle.budget_block_notifications (
  org_id uuid not null references noelle.organizations(id) on delete cascade,
  budget_period text not null check (budget_period in ('month', 'week')),
  period_started_at timestamptz not null,
  notified_at timestamptz not null default now(),
  notify_channel text not null check (notify_channel = 'pushover'),
  provider_request text not null
    check (length(btrim(provider_request)) between 1 and 65536),
  primary key (org_id, budget_period, period_started_at)
);
