-- Receipt status and cost provenance are separate; legacy accounting stays unknown.
alter table noelle.llm_calls add column if not exists cost_basis text not null default 'unknown'
  check (cost_basis in ('provider_reported', 'token_estimate', 'failure_estimate', 'not_dispatched', 'unknown'));
