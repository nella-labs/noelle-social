-- Per-agent toggle: when true, sending/marking-sent a reply automatically
-- "parks" that lead's DM (approval status -> 'deferred') instead of leaving it
-- pending. A parked DM drops off the review queue and shows on the person's
-- Contacts page with Copy + "Mark DM sent", so the operator sends it by hand
-- once they see the person reply on X. When false (default), the operator parks
-- DMs one at a time via the "Wait for reply" button (PR 2a).
--
-- 'deferred' is a plain text approvals.status (no CHECK constraint), so no enum
-- migration is needed; the pending inbox already filters status = 'pending'.

alter table noelle.agent_instances
  add column if not exists auto_defer_dms boolean not null default false;

comment on column noelle.agent_instances.auto_defer_dms is
  'When true, sending a reply auto-parks that lead''s DM (approval status=deferred) onto the person''s Contacts page instead of leaving it pending.';
