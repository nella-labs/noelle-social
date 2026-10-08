-- Each operator request has one durable refinement dispatch claim. Claims never expire automatically.
-- An explicit expected-request retry rotates the request before another dispatch is permitted.
alter table noelle.pattern_alerts
  add column if not exists refine_request_id uuid,
  add column if not exists refine_claim_id uuid;
