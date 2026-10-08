-- Auto-send mode for X Growth Intern.
--
-- When `auto_send_enabled = true` on an `agent_instances` row, the drafter
-- stamps `auto_send_target_at` on the first approval it creates per lead
-- (and immediately skips the sibling angles with skip_reason='auto-send-sibling'
-- so the inbox doesn't carry stale siblings). The send worker picks the
-- approval up once `now() >= auto_send_target_at` and posts to X via the
-- same path a human Send click takes.
--
-- Delay computation (apps/x-intern/src/lib/auto-send.ts):
--   1. baseDelay = uniform(min_delay_sec, max_delay_sec)
--   2. lengthFactor = clamp(0.5 + lastSentBodyLen / 280, 0.5, 1.5)
--   3. delay_sec = round(baseDelay * lengthFactor)
--   4. auto_send_target_at = now() + delay_sec
-- "Length of the last automatic sent" influences the schedule so a string
-- of long replies spaces itself out; a short reply doesn't pad the next one.
--
-- Rate brake: `auto_send_max_per_hour` caps how often the send worker
-- actually fires an auto-send for an instance. If the cap is hit, the
-- worker leaves the row and revisits it on the next tick — no need to
-- re-roll target_at.
--
-- Defaults match the founder's first-principles spec: "1 minute + random
-- 1-10 minutes". min=120 (60s base + 60s jitter min), max=660 (60s base +
-- 600s jitter max).

alter table noelle.agent_instances
  add column if not exists auto_send_enabled     boolean not null default false,
  add column if not exists auto_send_min_delay_sec  integer not null default 120
    check (auto_send_min_delay_sec >= 0),
  add column if not exists auto_send_max_delay_sec  integer not null default 660
    check (auto_send_max_delay_sec >= auto_send_min_delay_sec),
  add column if not exists auto_send_max_per_hour   integer not null default 6
    check (auto_send_max_per_hour > 0);

comment on column noelle.agent_instances.auto_send_enabled is
  'When true, drafter schedules approvals for automatic send via auto_send_target_at on the chosen angle; siblings are skipped at draft time.';

alter table noelle.approvals
  add column if not exists auto_send_target_at timestamptz;

comment on column noelle.approvals.auto_send_target_at is
  'Scheduled wall-clock for the send worker to auto-post this approval. NULL = human-review row (existing behaviour).';

-- Partial index: the send worker only scans rows still pending whose target
-- has been stamped. Drops to zero index pressure for the human-review path.
create index if not exists approvals_auto_send_due_idx
  on noelle.approvals (auto_send_target_at)
  where status = 'pending' and auto_send_target_at is not null;

-- Recent-sends count for the rate brake. Indexes (instance, decided_at) so
-- the "sent in the last hour by auto-send" probe stays O(log n).
create index if not exists approvals_decided_inst_idx
  on noelle.approvals (agent_instance_id, decided_at desc)
  where status = 'sent' and decided_by = 'auto-send';
