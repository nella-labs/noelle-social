-- Temporarily lift the budget cap for one org, until a moment in time.
--
-- The cap is a hard gate: every LLM call runs a three-layer pre-flight and a
-- BudgetExceededError stops the worker. That is the point — it is what would
-- have stopped the 2026-08-24 runaway on day one. But an operator sometimes
-- needs the agents to keep running past it (a launch, a backfill, a demo), and
-- the only alternative today is editing budget_cap_cents and remembering to put
-- it back. Nobody remembers to put it back.
--
-- NULL (the default) = cap enforced, which is the safe state. A timestamp in
-- the future lifts every cap layer for that org until it passes; a timestamp in
-- the past is inert, so the pause expires on its own and cannot be forgotten.
alter table noelle.organizations
  add column if not exists budget_cap_paused_until timestamptz;

comment on column noelle.organizations.budget_cap_paused_until is
  'Cap enforcement is skipped for this org while now() < this value. NULL = enforced. Expires on its own; never needs unsetting.';
