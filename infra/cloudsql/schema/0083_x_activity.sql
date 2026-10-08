-- Append-only activity log written by the X reply Actuator browser extension
-- (the browser twin of the LinkedIn actuator; mirrors 0054_linkedin_activity.sql).
-- Records likes (no pre-approval), executed replies (cross-ref approvals), and
-- skips (selector-not-found / challenge / cap-reached). Powers the x-health
-- endpoint and the server-side daily write-cap backstop. No RLS on Cloud SQL --
-- callers scope by org in app code.

create table if not exists noelle.x_activity (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null,
  session_id    uuid not null,
  type          text not null,        -- like | reply | skip
  approval_id   uuid,                 -- set for reply
  tweet_id      text,                 -- set for like (the liked tweet) / reply
  author_handle text,
  reason        text,                 -- set for skip
  created_at    timestamptz not null default now()
);

create index if not exists x_activity_org_day
  on noelle.x_activity (org_id, created_at);

comment on table noelle.x_activity is
  'Append-only action log from the X reply Actuator browser extension (likes/replies/skips).';

grant select, insert on noelle.x_activity to noelle_app;
