-- Phase 2. Run manually only after migration 0106 is valid AND all API/worker
-- processes serving lead writes have the new ON CONFLICT target. Until then the
-- old constraint protects old writers, but still prevents cross-tenant inserts.
-- Never put this file under schema/: the migration runner applies all pending
-- schema files before old processes have necessarily stopped.
do $$
begin
  if not exists (
    select 1 from pg_index
    where indexrelid = to_regclass('noelle.leads_org_platform_external_id_uq')
      and indisvalid
      and indisready
      and indisunique
  ) then
    raise exception 'tenant-scoped lead index is missing or invalid';
  end if;
end $$;

alter table noelle.leads drop constraint if exists leads_external_id_key;
