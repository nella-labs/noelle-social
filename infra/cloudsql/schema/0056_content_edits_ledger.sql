-- 0056_content_edits_ledger.sql
-- The noelle analog of content-pipeline's edits.md: every operator edit to a
-- generated post (the inline change captured at Mark ready) is recorded as a
-- before/after pair, per org. This is the highest-quality voice signal — the
-- operator showing, by correction, what "on voice" means. A later pass
-- materializes recent rows back into the per-org vault so both producers (the
-- post-drafter worker and the migrated skills) ground on these corrections.
create table if not exists noelle.content_edits (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references noelle.organizations(id) on delete cascade,
  draft_id    uuid references noelle.post_drafts(id) on delete set null,
  platform    text not null default 'linkedin',
  before_body text not null,
  after_body  text not null,
  created_at  timestamptz not null default now()
);

create index if not exists content_edits_org_idx
  on noelle.content_edits (org_id, created_at desc);
