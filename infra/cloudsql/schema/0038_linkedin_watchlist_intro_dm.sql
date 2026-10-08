-- infra/cloudsql/schema/0038_linkedin_watchlist_intro_dm.sql
-- One warm, relationship-building intro DM per watchlist person (Lyra).
--
-- Lyra already drafts replies to a watched connection's POSTS. This adds a
-- single, one-time intro DM per person: a genuine peer-to-peer note that
-- references their work and ASKS ABOUT THE PROJECT THEY'RE WORKING ON. No pitch
-- — it's relationship-building, not outreach. The DM is queued for human
-- approval like every other Lyra draft; Lyra NEVER auto-sends.
--
-- `intro_dm_drafted_at` is the "drafted exactly once, ever" stamp. The drafter's
-- claimIntroDmPeople RPC selects people where this column IS NULL (and who have a
-- generated profile, so the DM is personalized), stamps now() as it claims under
-- FOR UPDATE SKIP LOCKED, and never re-drafts a stamped person. A daily cap paces
-- it. One missed DM on a crash is acceptable (the claim removes the flag), exactly
-- like the per-person watchlist-drafting claim pattern.
--
-- The partial index keeps the "who still needs an intro DM?" claim cheap: it only
-- carries the unstamped rows, which shrink to empty once every watchlist person
-- has been introduced. Tenancy is unchanged — the claim scopes by
-- agent_instance_id, which the index leads on.

alter table noelle.linkedin_watchlist_people
  add column if not exists intro_dm_drafted_at timestamptz;

create index if not exists linkedin_watchlist_people_intro_dm_pending_idx
  on noelle.linkedin_watchlist_people (agent_instance_id)
  where intro_dm_drafted_at is null;
