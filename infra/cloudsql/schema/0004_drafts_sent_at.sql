-- infra/cloudsql/schema/0004_drafts_sent_at.sql
-- Adds the missing `sent_at` column to noelle.drafts. The 0003 watchlist
-- migration referenced this column in a partial-index WHERE clause but did
-- not create it; runbook bring-up against a fresh DB therefore had to apply
-- this migration before 0003 to avoid a "column does not exist" failure.
--
-- Idempotent so it's safe to re-run, including on hosts where the column
-- was hand-added during initial bring-up.

alter table noelle.drafts
  add column if not exists sent_at timestamptz;

create index if not exists drafts_sent_idx
  on noelle.drafts (sent_at)
  where sent_at is not null;
