-- infra/cloudsql/schema/0005_leads_full_schema.sql
-- The 0001 base schema declared noelle.leads with only (id, external_id,
-- org_id, payload, synced_at), but the live discovery + classifier +
-- drafter code (apps/x-intern/src/lib/leads-db.ts) expects an extended
-- shape with status pipelines, classifier metadata, and the
-- claim_leads_for_drafting RPC. This migration codifies what the code
-- actually needs.
--
-- Pipeline: leads.status transitions
--   'new'         (just discovered)
--      ↓ classifier picks up
--   'classifying'
--      ↓ classifier finishes
--   'classified'  (on-brand) | 'skipped' (off-brand)
--      ↓ drafter picks up classified
--   'drafting'
--      ↓ drafter finishes
--   'drafted'     | 'errored'
--
-- Idempotent — all column adds + the function definition use IF NOT
-- EXISTS / OR REPLACE.

-- ---- new columns on noelle.leads -----------------------------------------
alter table noelle.leads
  add column if not exists agent_instance_id uuid references noelle.agent_instances(id) on delete cascade,
  add column if not exists platform          text not null default 'x',
  add column if not exists status            text not null default 'new',
  add column if not exists author_handle     text,
  add column if not exists author_id         text,
  add column if not exists tier              text,
  add column if not exists classifier_label  text,
  add column if not exists classifier_score  numeric,
  add column if not exists created_at        timestamptz not null default now(),
  add column if not exists updated_at        timestamptz not null default now();

-- Pipeline index: classifier scans status='new' ordered by created_at;
-- drafter scans status='classified' ordered by created_at; both filter by
-- agent_instance_id.
create index if not exists leads_agent_status_created_idx
  on noelle.leads (agent_instance_id, status, created_at);

-- updated_at trigger (the helper function noelle.tg_set_updated_at()
-- already exists from 0001).
drop trigger if exists leads_set_updated_at on noelle.leads;
create trigger leads_set_updated_at
  before update on noelle.leads
  for each row execute function noelle.tg_set_updated_at();

-- ---- claim_leads_for_drafting RPC ----------------------------------------
-- Atomic "fetch + claim" used by the drafter worker. Selects the oldest N
-- classified leads for the given agent instance, flips their status to
-- 'drafting' under FOR UPDATE SKIP LOCKED so multiple drafters don't
-- claim the same row, returns the claimed rows.
create or replace function noelle.claim_leads_for_drafting(
  p_agent_instance_id uuid,
  p_batch             integer
)
returns table (
  id                uuid,
  external_id       text,
  payload           jsonb,
  author_handle     text,
  author_id         text,
  tier              text,
  classifier_label  text,
  classifier_score  numeric,
  status            text
)
language sql
as $$
  update noelle.leads
  set status = 'drafting', updated_at = now()
  where id in (
    select id from noelle.leads
    where agent_instance_id = p_agent_instance_id
      and status = 'classified'
    order by created_at asc
    for update skip locked
    limit p_batch
  )
  returning id, external_id, payload, author_handle, author_id, tier,
            classifier_label, classifier_score, status;
$$;

grant execute on function noelle.claim_leads_for_drafting(uuid, integer)
  to noelle_app;
