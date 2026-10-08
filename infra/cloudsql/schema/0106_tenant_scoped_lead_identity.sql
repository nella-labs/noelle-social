-- Phase 1 of tenant-scoped lead identity. Install this index before deploying
-- writers that use ON CONFLICT (org_id, platform, external_id). Keep the old
-- external_id constraint until every API and worker process uses the new target.
-- The migration runner executes each file outside a transaction, so CONCURRENTLY
-- avoids blocking the live lead writers while the index is built.
create unique index concurrently if not exists leads_org_platform_external_id_uq
  on noelle.leads (org_id, platform, external_id);
