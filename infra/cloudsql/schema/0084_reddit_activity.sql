-- Append-only activity log written by the Reddit reply Actuator browser
-- extension (the browser sibling of the X + LinkedIn actuators; mirrors
-- 0083_x_activity.sql). Records executed replies (cross-ref approvals) and skips
-- (selector-not-found / challenge / throttle / cap-reached). There is NO vote /
-- upvote type — automated voting is vote manipulation under Reddit's Disrupting
-- Communities / Responsible Builder policies and is bannable, so the actuator
-- never votes and this log has nothing to record for it. Powers the
-- reddit-health endpoint and the server-side daily write-cap backstop. No RLS on
-- Cloud SQL -- callers scope by org in app code.
--
-- Reddit-specific vs. x_activity: a reply can target the source POST or a
-- specific COMMENT in the thread, so this log carries both `post_id` and
-- `comment_id` (comment_id is set only when the reply targeted a comment). `at`
-- is the extension-supplied client event time (recorded verbatim); all
-- time-window filters (caps, halts, health) use the server-trusted `created_at`.

create table if not exists noelle.reddit_activity (
  id                uuid primary key default gen_random_uuid(),
  organization_id   uuid not null,
  agent_instance_id uuid,                 -- reserved for future per-instance attribution
  session_id        uuid not null,
  type              text not null,        -- reply | skip
  approval_id       uuid,                 -- set for reply
  post_id           text,                 -- the target post's t3 id (t3_ stripped)
  comment_id        text,                 -- set when the reply targeted a comment (t1_ stripped)
  subreddit         text,                 -- no r/ prefix
  reason            text,                 -- set for skip (selector-not-found / challenge / throttle / cap)
  at                text,                 -- extension-supplied client event time (verbatim)
  created_at        timestamptz not null default now()
);

create index if not exists reddit_activity_org_day
  on noelle.reddit_activity (organization_id, created_at);

comment on table noelle.reddit_activity is
  'Append-only action log from the Reddit reply Actuator browser extension (replies/skips; never votes).';

grant select, insert on noelle.reddit_activity to noelle_app;
