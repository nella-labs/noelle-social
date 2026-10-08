-- 0055_content_platform_reddit.sql
-- Widen the Content lane to a third platform: reddit (Orion).
--
-- post_ideas / post_drafts / ideation_requests all store `platform` as free
-- `text` with a 'linkedin' default (see 0045/0046/0050), so no column change is
-- required to admit 'reddit'. This migration documents the widening and, as a
-- guard, drops any platform CHECK constraint that a future hardening pass might
-- have added — so applying it is always safe and idempotent.
do $$
begin
  if exists (select 1 from pg_constraint where conname = 'post_ideas_platform_check') then
    alter table noelle.post_ideas drop constraint post_ideas_platform_check;
  end if;
  if exists (select 1 from pg_constraint where conname = 'post_drafts_platform_check') then
    alter table noelle.post_drafts drop constraint post_drafts_platform_check;
  end if;
end $$;
