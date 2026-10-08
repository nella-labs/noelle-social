-- infra/cloudsql/schema/0071_lead_vip_signal.sql
-- VIP / relationship-scout signal on a lead.
--
-- The classifier ("Lyra" for LinkedIn, "Vega" for X) already makes one LLM call
-- per lead with the author's name/headline (+ follower count on X). We piggy-back
-- on that same call to also judge whether the AUTHOR is a high-leverage person to
-- build a relationship with — an ICP match, a founder/investor (e.g. a YC founder),
-- or simply someone whose connection would be unusually impactful for the operator.
--
-- When the scout flags a lead it also pre-drafts a short, genuine intro DM opener
-- (a real question / coffee-chat ask, never a pitch) so the approvals page can
-- surface it instantly — api-vm cannot call an LLM, so the DM must be precomputed
-- here at classify time rather than generated on button-click.
--
-- Shape (jsonb), see packages/contracts/src/vip-signal.ts (VipSignalSchema):
--   { "vip": true,
--     "reason": "YC W24 founder building AI devtools — high-leverage intro",
--     "tags": ["yc-founder", "icp"],
--     "add_to_watchlist": true,
--     "dm_soon": true,
--     "suggested_dm": "Saw your post on agent eval — curious how you ..." }
--
-- NULL = the scout never ran for this lead (it predates the feature, or
-- NOELLE_VIP_SCOUT is off). A non-null row with "vip": false = scout ran and
-- judged the author NOT high-leverage. The approvals banner only renders for
-- "vip": true, so the column is fail-open: an absent/false value shows nothing.
--
-- Tenancy is enforced in app code (no RLS in Cloud SQL); this is lead metadata
-- read alongside the existing classifier_* columns.

alter table noelle.leads
  add column if not exists vip_signal jsonb;

comment on column noelle.leads.vip_signal is
  'Relationship-scout verdict from the classifier: {vip, reason, tags[], add_to_watchlist, dm_soon, suggested_dm}. NULL = scout never ran. See packages/contracts VipSignalSchema.';
