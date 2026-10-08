-- infra/cloudsql/schema/0050_ideation_requests.sql
-- On-demand trigger queue for the Posts ideation worker.
--
-- Ideation is operator-initiated: the dashboard "Generate ideas" / "Generate
-- weekly batch" buttons POST /api/posts/ideate, which inserts a pending request
-- here. The ideation worker (on the Lima VM) claims pending requests each tick
-- (FOR UPDATE SKIP LOCKED) and runs them, exactly like the other claim-based
-- workers. This keeps the button responsive (just an insert) and the heavy
-- gather+LLM work on the worker.
create table if not exists noelle.ideation_requests (
  id                 uuid primary key default gen_random_uuid(),
  org_id             uuid not null references noelle.organizations(id) on delete cascade,
  agent_instance_id  uuid not null references noelle.agent_instances(id) on delete cascade,
  -- 'single' (a handful of on-demand ideas) | 'batch' (~7 ideas Mon-Sun).
  mode               text not null default 'single',
  -- single mode: how many ideas to request. batch mode ignores this (=7).
  count              integer,
  -- Optional topic seeds biasing the net-new keyword search this run.
  topics             jsonb not null default '[]',
  -- batch mode: the Monday (YYYY-MM-DD) the week starts on.
  week_start         date,
  -- The batch_id stamped on every idea this run produces (groups the week).
  batch_id           uuid,
  status             text not null default 'pending', -- pending → running → done | error
  error_message      text,
  created_at         timestamptz not null default now(),
  claimed_at         timestamptz,
  finished_at        timestamptz
);

create index if not exists ideation_requests_claimable_idx
  on noelle.ideation_requests (status, created_at)
  where status = 'pending';
