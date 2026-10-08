-- Workload Identity Federation: Vercel functions impersonate the GCP service
-- account `vercel-noelle-app@noelle-agents.iam.gserviceaccount.com` to log in
-- without a password.
--
-- IMPORTANT: the Postgres role itself is created by `gcloud sql users
-- create ... --type=CLOUD_IAM_SERVICE_ACCOUNT` BEFORE applying this migration.
-- Don't `create user` here — that lands a BUILT_IN role that conflicts with
-- the IAM-typed user gcloud then refuses to create, and you have to drop the
-- BUILT_IN one (which owns 12 privileges) to recover. See runbook.md § 11.
--
-- The Cloud SQL convention strips `.gserviceaccount.com` from the SA email
-- when exposing the role in Postgres, so the role name is exactly:
--   "vercel-noelle-app@noelle-agents.iam"

grant connect on database postgres to "vercel-noelle-app@noelle-agents.iam";
grant usage on schema noelle to "vercel-noelle-app@noelle-agents.iam";

grant select, insert, update, delete on all tables in schema noelle
  to "vercel-noelle-app@noelle-agents.iam";

grant usage, select on all sequences in schema noelle
  to "vercel-noelle-app@noelle-agents.iam";

alter default privileges in schema noelle
  grant select, insert, update, delete on tables
  to "vercel-noelle-app@noelle-agents.iam";

alter default privileges in schema noelle
  grant usage, select on sequences
  to "vercel-noelle-app@noelle-agents.iam";
