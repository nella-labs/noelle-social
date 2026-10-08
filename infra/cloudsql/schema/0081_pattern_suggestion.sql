-- infra/cloudsql/schema/0081_pattern_suggestion.sql
-- Pattern Breaker: "try instead" positive guidance.
--
-- Every anti-pattern rule gains the POSITIVE mirror of its NEVER-DO line — one
-- imperative sentence saying what to do INSTEAD. The analyzer generates it in the
-- same pass; the drafter appends it to the ban block ("- <ban> → instead: <x>")
-- and the approvals popup shows it as "TRY INSTEAD" (joined from the live rule).
--
-- Nullable + no backfill: rules minted before this migration (and any finding
-- where the model omits it) simply show no "try instead" until re-detected. The
-- popup + drafter both degrade gracefully on null. Refine leaves it unchanged —
-- narrowing the ban keeps the original positive direction.
alter table noelle.pattern_rules
  add column if not exists suggestion text;
