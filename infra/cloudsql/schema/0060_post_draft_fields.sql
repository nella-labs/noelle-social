-- infra/cloudsql/schema/0060_post_draft_fields.sql
-- Content workspace, rich per-column post fields (content-pipeline parity).
--
-- The side-by-side platform columns need the full content-pipeline anatomy per
-- variant: a HOOK line, a CTA, free-form NOTES, a CATEGORY tag, and a STATUS
-- lifecycle (draft → written → scheduled → posted) shown as the column's STATUS
-- row. CONTENT is the existing `body`; POSTED URL is `posted_url` (0059).
--
-- `stage` is the operator-facing lifecycle on the column. The board `status`
-- (0046: draft/ready/published/dismissed) is SYNCED from it by the patch route:
--   draft               → status 'draft'      (on the board)
--   written | scheduled → status 'ready'      ("ready to post" KPI)
--   posted              → status 'published'  (archived off the board)
-- so the board/dedup logic is unchanged while the column shows the 4-stage UI.
--
-- All nullable / defaulted ⇒ backward compatible; existing drafts read as a
-- 'draft' stage with empty hook/cta/notes/category.

alter table noelle.post_drafts
  add column if not exists hook       text,
  add column if not exists cta        text,
  add column if not exists notes      text,
  add column if not exists category   text,
  add column if not exists stage      text not null default 'draft';
