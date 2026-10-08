-- Per-agent objective (mission) for every agent_instances row.
--
-- Until now an agent's "what am I for" lived only in code: the YAML manifest's
-- `short_description` and the chat profile's systemPrompt(). Neither was visible
-- to or editable by the operator. This column makes the objective a first-class,
-- user-owned field on the instance.
--
-- Semantics:
--   * NULL  → "use the agent type's manifest default" (short_description).
--             resolveObjective() in packages/runtime collapses NULL → manifest.
--   * text  → the operator's mission. Shown on the agent detail page, injected
--             into the classifier (relevance scoring) and drafter (reply
--             shaping) prompts for the X intern, and used as chat context so
--             Vega can propose targeting changes against it.
--
-- This is the *why*. The concrete *what it searches* (handles + keywords) stays
-- in noelle.x_watchlist (0003) — unchanged. Generic across roles so the CEO/CMO
-- placeholder pages can render an objective too.

alter table noelle.agent_instances
  add column if not exists objective text;

comment on column noelle.agent_instances.objective is
  'Operator-set mission for this agent. NULL = fall back to the manifest short_description. For x_intern it steers the classifier + drafter prompts; the concrete discovery targeting stays in noelle.x_watchlist.';
