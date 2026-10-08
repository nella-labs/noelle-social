-- Retained teardown attempt identities, committed before external work.
create table if not exists noelle.video_teardown_attempts (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references noelle.organizations(id) on delete cascade,
  agent_instance_id uuid not null references noelle.agent_instances(id) on delete cascade,
  clip_id uuid not null references noelle.video_clips(id) on delete cascade,
  platform text not null check (platform in ('instagram','tiktok')),
  status text not null check (status in ('queued','building','dispatched','unknown','failed','complete','superseded','released')),
  reason text check (reason in ('generation_in_progress','operator_retry','extraction_failed','generation_unknown',
    'generation_failed','completion_failed','source_changed','dispatch_uncertain')),
  source_snapshot jsonb not null default '{}'::jsonb check (jsonb_typeof(source_snapshot)='object'),
  predecessor_id uuid references noelle.video_teardown_attempts(id),
  operator_id text,
  created_at timestamptz not null default now(),
  admitted_at timestamptz,
  dispatched_at timestamptz,
  finished_at timestamptz,
  teardown_id uuid references noelle.video_teardowns(id) on delete set null
);

-- Completed attempts stay current; only explicit recovery or proven release frees admission.
create unique index if not exists video_teardown_attempts_current_clip_idx
  on noelle.video_teardown_attempts (clip_id) where status not in ('superseded','released');
create index if not exists video_teardown_attempts_instance_created_idx
  on noelle.video_teardown_attempts (agent_instance_id,org_id,created_at,id);
create index if not exists video_teardown_attempts_predecessor_idx
  on noelle.video_teardown_attempts (predecessor_id);
grant select,insert,update on noelle.video_teardown_attempts to noelle_app;
revoke delete on noelle.video_teardown_attempts from noelle_app;
