-- infra/cloudsql/schema/0043_linkedin_icp_config.sql
-- Profile-first discovery for Lyra (the LinkedIn intern).
--
-- The operator's lead model is person-first, not post-first: "if a profile
-- matches the ICP (young / founder / YC / growth) AND has a recent, engaged
-- post, it's a lead." This adds the per-instance ICP definition that drives:
--   - the AUTHOR gate on the keyword SEARCH lane (only keep posts whose author's
--     headline matches the ICP), and
--   - a new PROFILE-FIRST feeder (HarvestAPI profile-search → that person's
--     recent engaged posts), both marking their leads priority=true so the
--     classifier never hard-skips a vetted person (clamped to 'light').
--
-- icp_config shape (validated by packages/contracts IcpConfigSchema; NULL =
-- profile-first discovery is OFF and Lyra behaves exactly as before):
--   {
--     "searchQuery": "founder growth",
--     "currentJobTitles": ["Founder","CEO","Co-Founder"],
--     "yearsOfExperienceIds": ["1","2"],
--     "locations": [], "seniorityLevelIds": [], "industryIds": [], "schools": [],
--     "maxProfiles": 50,
--     "postQueries": ["building in public","first customer"],
--     "headlineKeywords": ["founder","ceo","building","yc","growth"],
--     "headlineExcludeKeywords": ["recruiter","hiring","agency"],
--     "minReactions": 10,
--     "timeWindowHours": 24
--   }
alter table noelle.agent_instances
  add column if not exists icp_config jsonb;

-- Provenance for a watchlist person — 'manual' (operator-added connection),
-- 'profile_search' / 'post_search' (auto-added by profile-first discovery).
-- Default 'manual' so every existing row keeps its meaning. Reserved for the
-- watchlist-compounding follow-up; harmless now.
alter table noelle.linkedin_watchlist_people
  add column if not exists source text not null default 'manual';
