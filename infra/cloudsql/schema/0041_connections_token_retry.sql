-- infra/cloudsql/schema/0041_connections_token_retry.sql
-- Per-token retry/billing date for the Apify fallback pool. 0040 marked a token
-- `exhausted_at` on a 403 and only ever retried it as a last resort (tried last,
-- self-healing only if it happened to succeed). That means a token whose monthly
-- cycle has since reset can sit dead behind a working token forever.
--
-- `retry_at` fixes that: when a token is marked exhausted, the worker stamps
-- retry_at = exhausted_at + ~30 days (its expected billing reset). The resolver
-- treats a token as AVAILABLE again once now() >= retry_at, so it proactively
-- re-enters rotation on its reset date — succeeds (and clears the flag) if the
-- cycle really reset, or re-cools for another 30 days if not.

alter table noelle.connections
  -- retry/billing date: an EXHAUSTED token (403 monthly cap) re-enters rotation
  -- once now() >= retry_at.
  add column if not exists retry_at timestamptz,
  -- when a token returned 401 "token not valid" — it's the wrong/dead token, not
  -- a cap. Invalid tokens are excluded from rotation entirely (they never reset on
  -- their own) until the operator re-pastes a good one. Distinct from exhausted so
  -- the UI says "invalid — replace" instead of "retries <date>".
  add column if not exists invalid_at timestamptz;

-- Backfill any already-exhausted rows (0040 era, retry_at null) with a 30-day
-- horizon from when they were marked, so they're not stuck dead post-upgrade.
update noelle.connections
  set retry_at = exhausted_at + interval '30 days'
  where exhausted_at is not null and retry_at is null;
