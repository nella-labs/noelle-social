-- Per-agent policy columns and supporting state for the dashboard
-- escalation / alert toggles.
--
-- See:
--   apps/app/src/app/app/[orgSlug]/agents/[instanceId]/config/page.tsx
--   apps/x-intern/src/workers/drafter*.ts
--   packages/runtime/src/pushoverClient.ts
--
-- Defaults alert at 75%, route to
-- approvals when cap is hit, pause on repeated 5xx. Low-confidence notify
-- is off by default until a notification channel is configured.

alter table noelle.agent_instances
  add column if not exists budget_alert_pct      integer not null default 75
    check (budget_alert_pct between 50 and 100),
  add column if not exists escalate_on_cap       boolean not null default true,
  add column if not exists pause_on_5xx          boolean not null default true,
  add column if not exists notify_low_confidence boolean not null default false;

-- One row per (instance, calendar-month) when the spend crossed the
-- configured alert_pct threshold. UNIQUE constraint dedupes — the
-- spendRecorder hook will INSERT ... ON CONFLICT DO NOTHING so a flood
-- of post-call hits doesn't re-fire the Pushover ping.
create table if not exists noelle.budget_alerts (
  id                uuid primary key default gen_random_uuid(),
  agent_instance_id uuid not null references noelle.agent_instances(id) on delete cascade,
  month             date not null,
  fired_at          timestamptz not null default now(),
  spend_cents       integer not null,
  cap_cents         integer not null,
  alert_pct         integer not null,
  notify_channel    text,           -- "pushover" | future: "email" | "slack"
  notify_status     text,           -- "sent" | "no_channel" | "error"
  notify_detail     text,
  unique (agent_instance_id, month)
);
create index if not exists budget_alerts_inst_idx
  on noelle.budget_alerts (agent_instance_id);
create index if not exists budget_alerts_month_idx
  on noelle.budget_alerts (month desc);

-- One row per cap-block event when escalate_on_cap=true. Surfaced in the
-- UI as a "N drafts blocked by your monthly cap" banner / feed. Separate
-- table from approvals because there's no draft to approve — just a
-- budget decision the founder needs to make (raise the cap, or wait for
-- the next calendar month).
create table if not exists noelle.budget_escalations (
  id                uuid primary key default gen_random_uuid(),
  agent_instance_id uuid not null references noelle.agent_instances(id) on delete cascade,
  org_id            uuid not null references noelle.organizations(id) on delete cascade,
  lead_id           uuid references noelle.leads(id) on delete set null,
  attempted_cents   integer not null,
  cap_cents         integer not null,
  acknowledged_at   timestamptz,
  created_at        timestamptz not null default now()
);
create index if not exists budget_escalations_org_unack_idx
  on noelle.budget_escalations (org_id, acknowledged_at)
  where acknowledged_at is null;
create index if not exists budget_escalations_inst_idx
  on noelle.budget_escalations (agent_instance_id, created_at desc);
