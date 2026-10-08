-- Wire spend rows back to the agent instance that incurred the cost.
--
-- Previously noelle.llm_calls only carried (org_id, agent_role), which
-- worked while each org had at most one instance per role (the 0.0.1
-- invariant enforced by agent_instances_org_role_unique). That made
-- the budget cap check in apps/x-intern/src/lib/budget-adapters.ts
-- proxy per-instance spend through agent_role. The proxy is fine, but
-- conflates instances the moment we ship multiple agents of the same
-- role per org — and the role-based join is awkward to read.
--
-- This migration adds the explicit column, indexes it for the spend
-- aggregation query, and backfills historical rows from the existing
-- (org_id, agent_role) tuple so the spend page stays accurate the
-- moment the new query lands.
--
-- on delete set null preserves historical spend if an instance is
-- later deleted (chargeback / forensics / accidental delete).

alter table noelle.llm_calls
  add column if not exists agent_instance_id uuid
    references noelle.agent_instances(id) on delete set null;

create index if not exists llm_calls_instance_started_idx
  on noelle.llm_calls (agent_instance_id, started_at desc);

-- Backfill historical rows. agent_instances_org_role_unique guarantees
-- at most one match per (org_id, agent_role), so this is unambiguous.
-- The `where agent_instance_id is null` guard makes the statement safe
-- to re-run.
update noelle.llm_calls c
   set agent_instance_id = a.id
  from noelle.agent_instances a
 where c.agent_instance_id is null
   and c.org_id = a.org_id
   and c.agent_role = a.role;

comment on column noelle.llm_calls.agent_instance_id is
  'Agent instance that incurred this LLM cost. Populated by the spend recorder; NULL only for very old rows or for system-level calls not tied to a hired agent.';
