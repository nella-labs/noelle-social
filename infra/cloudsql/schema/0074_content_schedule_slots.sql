-- 0074_content_schedule_slots.sql
--
-- The Content workspace Schedule calendar + the Compose action engine share ONE
-- schedulable unit: a "slot". A slot is a planned publish time for one piece of
-- content on one platform. It starts `empty` (a reserved time with no draft),
-- gets materialised just-in-time into a real draft (`drafting` -> `drafted`),
-- is marked `ready`, and — for Vega only — auto-published via the official X API
-- (`publishing` -> `published`). Draft-only agents (Lyra/Orion/Nova) never
-- auto-publish: their slots stop at `ready` and surface as copy-out.
--
-- `agent_compose_jobs` is the batch HEADER for a Compose run ("7 posts/day for 2
-- weeks" -> N slots sharing one batch_id). It holds progress + cancel state only;
-- the schedulable rows are always content_schedule_slots (there is no separate
-- compose-items table — the slot IS the item).
--
-- Tenancy: app code enforces org membership (no RLS in Cloud SQL). Grants are
-- inherited from the schema-level ALTER DEFAULT PRIVILEGES in 0001. Hand-applied
-- migration, no ledger.

-- ── Compose batch header ────────────────────────────────────────────────────
create table if not exists noelle.agent_compose_jobs (
  id                  uuid primary key default gen_random_uuid(),
  org_id              uuid not null references noelle.organizations(id) on delete cascade,
  agent_instance_id   uuid not null references noelle.agent_instances(id) on delete cascade,
  -- The Compose action this batch ran: bulk_draft | reply_batch | remix.
  kind                text not null,
  -- The natural-language ask + the parsed plan that produced the slots.
  prompt              text,
  plan                jsonb not null default '{}'::jsonb,
  status              text not null default 'planned',  -- planned | running | done | cancelled | failed
  items_total         integer not null default 0,
  items_materialized  integer not null default 0,
  items_drafted       integer not null default 0,
  items_failed        integer not null default 0,
  horizon_days        integer not null default 14,
  created_by          text,            -- Supabase sub of the operator who ran it
  error_message       text,
  created_at          timestamptz not null default now(),
  started_at          timestamptz,
  finished_at         timestamptz,
  updated_at          timestamptz not null default now()
);

create index if not exists agent_compose_jobs_instance_idx
  on noelle.agent_compose_jobs (agent_instance_id, created_at desc);

-- ── The unified schedulable slot ────────────────────────────────────────────
create table if not exists noelle.content_schedule_slots (
  id                  uuid primary key default gen_random_uuid(),
  org_id              uuid not null references noelle.organizations(id) on delete cascade,
  agent_instance_id   uuid not null references noelle.agent_instances(id) on delete cascade,
  -- The OWNING instance's platform — never re-derived from a fan-out draft.
  platform            text not null,                    -- x | linkedin | reddit | video
  slot_at             timestamptz not null,
  status              text not null default 'empty',
    -- empty | drafting | drafted | ready | publishing | published | skipped | failed
  -- Soft refs (no FK): the slot outlives idea/draft churn.
  idea_id             uuid,                             -- noelle.post_ideas(id)
  draft_id            uuid,                             -- post_drafts(id) (text) / video studio draft (Nova)
  -- Only Vega (x_intern) may ever set this true — enforced by the trigger below.
  auto_publish        boolean not null default false,
  window_source       text not null default 'auto',    -- auto | manual | batch
  batch_id            uuid references noelle.agent_compose_jobs(id) on delete set null,
  -- JIT: an `empty` slot is materialised into a draft once now() >= this.
  materialize_after   timestamptz,
  target_kind         text not null default 'post_idea',  -- post_idea | remix_idea | reply_lead
  target_lead_id      uuid,                             -- noelle.leads(id) for reply slots (soft ref)
  seed                jsonb,                            -- optional generation seed (remix source, etc.)
  posted_url          text,
  published_at        timestamptz,
  error_message       text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

-- Publish claim: the Vega-only publish worker scans ready+auto_publish slots.
create index if not exists content_schedule_slots_publish_claim_idx
  on noelle.content_schedule_slots (slot_at)
  where status = 'ready' and auto_publish = true;

-- JIT materialise: the drafter pre-pass scans due empty slots.
create index if not exists content_schedule_slots_materialize_idx
  on noelle.content_schedule_slots (materialize_after)
  where status = 'empty';

-- Calendar reads.
create index if not exists content_schedule_slots_org_time_idx
  on noelle.content_schedule_slots (org_id, slot_at);
create index if not exists content_schedule_slots_instance_time_idx
  on noelle.content_schedule_slots (agent_instance_id, slot_at);

-- One draft binds to at most one slot.
create unique index if not exists content_schedule_slots_draft_uq
  on noelle.content_schedule_slots (draft_id)
  where draft_id is not null;

-- Batch progress rollup.
create index if not exists content_schedule_slots_batch_idx
  on noelle.content_schedule_slots (batch_id, slot_at)
  where batch_id is not null;

-- ── Structural draft-only gate (layer 4 of 5) ──────────────────────────────
-- A slot can only carry auto_publish=true if its OWNING instance is an x_intern
-- (Vega). A Lyra/Orion/Nova-owned slot — including a cross-platform fan-out
-- draft — can never even hold the auto-publish flag, so it can never be claimed
-- by the publish worker. This is enforced in the database, not just app code.
create or replace function noelle.tg_content_slot_autopublish_role_chk()
returns trigger
language plpgsql
as $$
begin
  if new.auto_publish then
    if (select role from noelle.agent_instances where id = new.agent_instance_id) is distinct from 'x_intern' then
      raise exception
        'auto_publish is only permitted for x_intern agents (slot %, instance %)',
        new.id, new.agent_instance_id;
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists content_schedule_slots_autopublish_role_chk on noelle.content_schedule_slots;
create trigger content_schedule_slots_autopublish_role_chk
  before insert or update on noelle.content_schedule_slots
  for each row execute function noelle.tg_content_slot_autopublish_role_chk();

-- Keep updated_at fresh (reuses the shared helper from 0001).
drop trigger if exists content_schedule_slots_set_updated_at on noelle.content_schedule_slots;
create trigger content_schedule_slots_set_updated_at
  before update on noelle.content_schedule_slots
  for each row execute function noelle.tg_set_updated_at();

drop trigger if exists agent_compose_jobs_set_updated_at on noelle.agent_compose_jobs;
create trigger agent_compose_jobs_set_updated_at
  before update on noelle.agent_compose_jobs
  for each row execute function noelle.tg_set_updated_at();
