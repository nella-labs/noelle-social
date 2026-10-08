-- Retained recording-brief identities; the existing output UUID stays stable.
create table if not exists noelle.video_recording_brief_attempts (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references noelle.organizations(id) on delete cascade,
  agent_instance_id uuid not null references noelle.agent_instances(id) on delete cascade,
  draft_id uuid not null references noelle.video_drafts(id) on delete cascade,
  idea_id uuid not null references noelle.video_ideas(id) on delete cascade,
  brief_id uuid not null references noelle.video_recording_briefs(id),
  platform text not null,
  status text not null check (status in ('queued','building','dispatched','unknown','failed','complete','superseded','released')),
  reason text check (reason in ('generation_in_progress','operator_retry','preparation_failed','generation_unknown',
    'generation_failed','completion_failed','source_changed','dispatch_uncertain')),
  source_snapshot jsonb check (source_snapshot is null or jsonb_typeof(source_snapshot)='object'),
  configured_engine text,
  configured_model text,
  predecessor_id uuid references noelle.video_recording_brief_attempts(id),
  operator_id text,
  created_at timestamptz not null default now(),
  admitted_at timestamptz,
  dispatched_at timestamptz,
  finished_at timestamptz
);
create unique index if not exists video_recording_brief_attempts_current_draft_idx
  on noelle.video_recording_brief_attempts(draft_id) where status not in ('superseded','released');
create index if not exists video_recording_brief_attempts_instance_created_idx
  on noelle.video_recording_brief_attempts(agent_instance_id,org_id,created_at,id);
create index if not exists video_recording_brief_attempts_predecessor_idx
  on noelle.video_recording_brief_attempts(predecessor_id);

-- Preserve recorded legacy holds. Their source and dispatch evidence remain unknown.
insert into noelle.video_recording_brief_attempts
  (id,org_id,agent_instance_id,draft_id,idea_id,brief_id,platform,status,reason,configured_engine,configured_model,created_at)
select b.id,b.org_id,b.agent_instance_id,b.draft_id,b.idea_id,b.id,b.platform,b.status,
  case when b.brief->>'failureReason' in ('generation_unknown','generation_failed','completion_failed','source_changed','dispatch_uncertain')
    then b.brief->>'failureReason' when b.status='unknown' then 'generation_unknown'
    when b.status='failed' then 'generation_failed' else 'generation_in_progress' end,
  b.source_engine,b.model,b.created_at
from noelle.video_recording_briefs b where b.status in ('building','dispatched','unknown','failed')
  and not exists(select 1 from noelle.video_recording_brief_attempts a where a.draft_id=b.draft_id)
on conflict(id) do nothing;
grant select,insert,update on noelle.video_recording_brief_attempts to noelle_app;
revoke delete on noelle.video_recording_brief_attempts from noelle_app;
