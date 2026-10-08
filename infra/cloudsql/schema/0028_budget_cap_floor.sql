-- infra/cloudsql/schema/0028_budget_cap_floor.sql
-- Raise legacy sub-floor budget caps to the $25 (2500¢) minimum the dashboard
-- now enforces. Some rows predate the minimum and hold a tiny cap (e.g. 500¢ =
-- $5). The config input clamps the DISPLAY up to $25, but the "spent this month"
-- line and the runtime three-layer pre-flight read the raw column — so the card
-- showed "$3.65 / $5.00" beneath a "$25" input, AND the agent actually stopped
-- spending at $5. Bumping the stored value to the floor makes the input, the
-- spent line, and enforcement all agree. Only touches rows strictly between 0
-- and the floor — a 0 cap (if any) is left as-is, and anything >= floor is fine.

update noelle.agent_instances
  set budget_cap_cents = 2500, updated_at = now()
  where budget_cap_cents > 0
    and budget_cap_cents < 2500;
