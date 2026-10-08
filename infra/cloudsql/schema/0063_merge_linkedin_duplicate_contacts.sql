-- infra/cloudsql/schema/0063_merge_linkedin_duplicate_contacts.sql
-- One-time cleanup: merge LinkedIn contacts that are the SAME person split across
-- two handles. LinkedIn vanity slugs carry a trailing `-<hex id>` when the profile
-- has no custom vanity URL (e.g. `kaia-tham-7bb065343`); the same human can also be
-- added under a clean vanity (`kaia-tham`). reconcileContactsForOrg used to mint a
-- separate noelle.persons row for an Account-Feeder source stored under the raw
-- slug, so a person watched as `kaia-tham` AND fed as `kaia-tham-7bb065343` showed
-- up TWICE in Contacts.
--
-- The reconcile + feeder queries now match LinkedIn on the suffix-stripped handle
-- (see normalizeLinkedinHandle / the `regexp_replace(handle,'-[0-9a-f]{6,}$','')`
-- guards), so no NEW duplicates are created. This migration folds the EXISTING
-- ones into a single contact: pick the clean (shortest) handle as canonical, move
-- any non-redundant data onto it, then delete the duplicate person. Idempotent —
-- after it runs there are no normalized-duplicate LinkedIn groups left, so a
-- re-run is a no-op.

begin;

-- Merge map: for every (org, normalized LinkedIn handle) that resolves to more
-- than one person, the canonical person (clean/shortest handle, oldest on ties)
-- and the duplicates to fold into it.
create temporary table _li_merge as
with li as (
  select p.id as person_id, p.org_id, p.created_at, a.handle,
         regexp_replace(lower(a.handle), '-[0-9a-f]{6,}$', '') as norm,
         length(a.handle) as hlen
  from noelle.persons p
  join noelle.person_social_accounts a
    on a.person_id = p.id and a.platform = 'linkedin'
),
groups as (
  select org_id, norm
  from li
  group by org_id, norm
  having count(distinct person_id) > 1
),
ranked as (
  select li.*,
         row_number() over (
           partition by li.org_id, li.norm
           order by li.hlen asc, li.created_at asc, li.handle asc, li.person_id asc
         ) as rn
  from li
  join groups g on g.org_id = li.org_id and g.norm = li.norm
)
select distinct
  d.person_id        as dup_person_id,
  c.person_id        as canonical_person_id
from ranked d
join ranked c on c.org_id = d.org_id and c.norm = d.norm and c.rn = 1
where d.rn > 1 and d.person_id <> c.person_id;

-- 1. Repoint X watchlist rows (the only other person_id FK) dup → canonical.
update noelle.x_watchlist_people wp
set person_id = m.canonical_person_id
from _li_merge m
where wp.person_id = m.dup_person_id;

-- 2. Move any social account the canonical does NOT already hold (by platform +
--    normalized handle) from the dup onto the canonical, so an X handle or a
--    genuinely-distinct account on the dup is never lost. Redundant suffixed
--    LinkedIn rows are left on the dup and vanish with it in step 4.
update noelle.person_social_accounts a
set person_id = m.canonical_person_id
from _li_merge m
where a.person_id = m.dup_person_id
  and not exists (
    select 1 from noelle.person_social_accounts c
    where c.person_id = m.canonical_person_id
      and c.platform = a.platform
      and regexp_replace(lower(c.handle), '-[0-9a-f]{6,}$', '')
          = regexp_replace(lower(a.handle), '-[0-9a-f]{6,}$', '')
  );

-- 3. Carry the dup's notes / display_name onto the canonical when it lacks them.
update noelle.persons c
set notes = coalesce(c.notes, d.notes),
    display_name = coalesce(nullif(c.display_name, ''), d.display_name),
    updated_at = now()
from _li_merge m
join noelle.persons d on d.id = m.dup_person_id
where c.id = m.canonical_person_id;

-- 4. Delete the duplicate persons. ON DELETE CASCADE drops their remaining
--    (now-redundant, suffixed) person_social_accounts rows; x_watchlist already
--    repointed in step 1.
delete from noelle.persons p
using _li_merge m
where p.id = m.dup_person_id;

drop table _li_merge;

commit;
