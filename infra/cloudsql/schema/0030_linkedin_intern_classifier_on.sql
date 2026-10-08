-- infra/cloudsql/schema/0030_linkedin_intern_classifier_on.sql
-- The LinkedIn intern (Lyra) was originally seeded with classifier_enabled=false
-- (back when it had no classifier — "reply to everything"). The quality pipeline
-- adds a real classifier (discovery → classifier → drafter), so the classifier
-- worker must be enabled or leads stay status='new' forever and nothing drafts.
-- 0029's seed is on-conflict-do-nothing, so it won't update an existing row —
-- flip it here for any already-seeded linkedin_intern instance. Idempotent.
update noelle.agent_instances
  set classifier_enabled = true, updated_at = now()
where role = 'linkedin_intern' and classifier_enabled is distinct from true;
