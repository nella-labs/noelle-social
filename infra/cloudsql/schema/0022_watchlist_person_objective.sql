-- infra/cloudsql/schema/0022_watchlist_person_objective.sql
-- Per-watchlist-person objective: a preset `kind` + optional free-text note
-- that steers HOW Vega drafts the reply + DM for that person's posts (e.g.
-- "build relationship — be present about what they ship, no pitching").
-- NULL kind = today's behavior (the drafter uses the instance objective only).
-- See docs/superpowers/specs/2026-05-31-watchlist-person-objective-design.md.
-- Preset keys mirror @noelle/contracts WATCHLIST_OBJECTIVES (single source of
-- truth for label + drafter directive).

alter table noelle.x_watchlist_people
  add column if not exists objective_kind text
    check (objective_kind in ('relationship', 'feedback', 'pitch', 'amplify')),
  add column if not exists objective_note text;
