-- 0032_backfill_linkedin_classifier_score.sql
--
-- One-time data fix for the "7800/100" bug. The LinkedIn classifier used to
-- store the raw 0-100 `q` into noelle.leads.classifier_score, while the shared
-- approval UI does Math.round(classifier_score * 100) — so a q=78 lead rendered
-- as "7800/100". The worker now normalises to 0-1 (q/100), matching the X
-- intern. This migration rescales the LinkedIn rows that were written on the
-- old 0-100 scale so historical leads display correctly too.
--
-- Idempotent: the 0-1 contract caps a valid score at 1.0, so only rows still on
-- the old scale have classifier_score > 1. Re-running this is a no-op once every
-- LinkedIn row is <= 1. Scoped to platform='linkedin' so X rows (already 0-1)
-- are never touched.

update noelle.leads
set classifier_score = classifier_score / 100.0,
    updated_at = now()
where platform = 'linkedin'
  and classifier_score is not null
  and classifier_score > 1;
