-- infra/cloudsql/schema/0059_content_crossplatform.sql
-- Content workspace, cross-platform fan-out.
--
-- PR #252 modelled an idea as single-platform (one idea = one platform) and used
-- platform as a board filter. content-pipeline's real design is the opposite:
-- ONE source idea fans out into many platform variants, generated together and
-- edited side by side, each with its own versions. This migration makes the
-- noelle `post_ideas` row that cross-platform source concept.
--
--   post_ideas.platform        — the idea's HOME platform (owning instance). Kept
--                                as-is; the LinkedIn intern owns the post pipeline.
--   post_ideas.target_platforms — the set the idea fans out into (e.g. {linkedin,x}).
--                                The post-drafter drafts ONE post per entry.
--   post_ideas.pending_platforms — when non-null, the subset to (re)draft on the
--                                next tick (a per-platform "+ Version" / regen).
--                                null = draft all target_platforms.
--
-- Drafts already carry their own `platform` + `idea_id` (0046), so one idea →
-- many drafts across platforms = the fan-out, and many drafts of the SAME
-- platform under one idea = its versions. No draft-table reshape needed beyond a
-- posted_url field (the "POSTED URL" the operator pastes after publishing).
--
-- Backward compatible: existing single-platform ideas get target_platforms =
-- ARRAY[platform], so they keep drafting exactly one platform as before.

alter table noelle.post_ideas
  add column if not exists target_platforms text[] not null default '{linkedin}',
  add column if not exists pending_platforms text[];

-- Backfill the fan-out set from each existing idea's home platform, so legacy
-- single-platform rows keep their behavior. SCOPED to be re-run safe (this repo
-- applies migrations by hand with no schema_migrations ledger): only touch
-- non-linkedin-home rows still holding the seeded '{linkedin}' default. A
-- linkedin-home row is already correct as '{linkedin}', and a cross-platform
-- idea created after this migration (home 'linkedin', set '{linkedin,x}') is
-- never matched — so re-running can't clobber a fan-out set.
update noelle.post_ideas
  set target_platforms = array[platform]
  where platform <> 'linkedin' and target_platforms = array['linkedin'];

alter table noelle.post_drafts
  add column if not exists posted_url text;
