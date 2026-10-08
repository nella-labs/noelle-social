-- 0017_purge_synthetic_leads.sql
--
-- One-time data purge: remove synthetic / seed leads that leaked into the
-- live noelle.leads table out-of-band (their external_id is prefixed
-- `synthetic-` — e.g. `synthetic-nella-fit-1779215446.089065`). They were
-- never produced by committed code; a demo/seed path inserted them directly.
--
-- Why they are noise:
--   * Their external_id is not a real tweet id, so the X "reply" anchor
--     (in_reply_to) points at nothing — these can never actually send.
--   * They flow leads -> drafts -> approvals and clutter the human approval
--     queue with unusable drafts.
--
-- Scope: ALL orgs (synthetic data is test noise wherever it lives).
--
-- Cascade: noelle.drafts.lead_id and noelle.approvals.lead_id (and
-- approvals.draft_id -> drafts) are all `on delete cascade`, so deleting the
-- lead row removes its drafts and approvals automatically. See
-- infra/cloudsql/schema/0001_noelle_schema.sql §leads/drafts/approvals.
--
-- Idempotent: re-running after the rows are gone deletes 0 rows.
-- A query-level guard in apps/app (listPendingApprovalsForOrg, source='real')
-- prevents any future synthetic rows from reaching the queue even before this
-- runs again.

begin;

do $$
declare
  lead_n   bigint;
  draft_n  bigint;
  appr_n   bigint;
begin
  select count(*) into lead_n  from noelle.leads     where external_id like 'synthetic-%';
  select count(*) into draft_n from noelle.drafts  d
    join noelle.leads l on l.id = d.lead_id where l.external_id like 'synthetic-%';
  select count(*) into appr_n  from noelle.approvals a
    join noelle.leads l on l.id = a.lead_id where l.external_id like 'synthetic-%';

  raise notice 'purging synthetic leads: % leads, % drafts, % approvals (cascade)', lead_n, draft_n, appr_n;
end $$;

-- Cascade deletes the dependent drafts + approvals.
delete from noelle.leads where external_id like 'synthetic-%';

commit;
