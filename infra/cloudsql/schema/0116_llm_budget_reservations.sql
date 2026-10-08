-- Unsettled admissions remain charged until a confirmed receipt settles them.
create unique index if not exists agent_instances_org_id_id_unique
  on noelle.agent_instances (org_id, id);

create table if not exists noelle.llm_budget_reservations (
  id uuid primary key,
  org_id uuid not null references noelle.organizations(id) on delete cascade,
  agent_instance_id uuid,
  agent_role text not null,
  worker text not null,
  engine text not null,
  model text not null,
  bucket text not null,
  estimated_cents integer not null check (estimated_cents >= 0),
  admitted_at timestamptz not null default clock_timestamp(),
  settled_at timestamptz,
  foreign key (org_id, agent_instance_id)
    references noelle.agent_instances(org_id, id) on delete set null (agent_instance_id)
);
create index if not exists llm_budget_reservations_unsettled_org
  on noelle.llm_budget_reservations (org_id) where settled_at is null;

alter table noelle.llm_calls add column if not exists attempt_id uuid
  references noelle.llm_budget_reservations(id) on delete restrict;
create unique index if not exists llm_calls_attempt_id_unique
  on noelle.llm_calls (attempt_id);
grant select, insert, update on noelle.llm_budget_reservations to noelle_app;
