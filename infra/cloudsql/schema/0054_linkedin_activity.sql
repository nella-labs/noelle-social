-- Append-only activity log written by the LinkedIn Actuator browser extension.
-- Records likes (no pre-approval), executed comments/DMs (cross-ref approvals),
-- and skips (selector-not-found / challenge / cap-reached). Powers dashboard
-- counters and an optional server-side daily backstop. No RLS on Cloud SQL —
-- callers scope by org in app code.

create table if not exists noelle.linkedin_activity (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null,
  session_id   uuid not null,
  type         text not null,        -- like | comment | dm | skip
  approval_id  uuid,                 -- set for comment / dm
  activity_urn text,                 -- set for like
  author_name  text,
  reason       text,                 -- set for skip
  created_at   timestamptz not null default now()
);

create index if not exists linkedin_activity_org_day
  on noelle.linkedin_activity (org_id, created_at);

comment on table noelle.linkedin_activity is
  'Append-only action log from the LinkedIn Actuator browser extension (likes/comments/dms/skips).';

grant select, insert on noelle.linkedin_activity to noelle_app;
