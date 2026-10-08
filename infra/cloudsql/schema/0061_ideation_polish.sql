-- infra/cloudsql/schema/0061_ideation_polish.sql
-- Idea-level "polish" rides the existing ideation queue. A polish request reuses
-- noelle.ideation_requests with mode='polish' and targets ONE existing idea
-- (idea_id); the ideation worker refines that idea in place (sharper hook +
-- thesis, kept on-voice) instead of generating new idea cards.
--
-- Additive + nullable: 'single'/'batch' rows, the claimable index, and the
-- existing claim/finish loop are all unaffected.
alter table noelle.ideation_requests
  add column if not exists idea_id uuid references noelle.post_ideas(id) on delete cascade;
