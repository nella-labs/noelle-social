-- A chat creation request must stop before automatic approval or publishing.
alter table noelle.ideation_requests
  add column if not exists require_review boolean not null default false;
