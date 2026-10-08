-- infra/cloudsql/schema/0042_classifier_threshold.sql
-- Per-instance classifier quality threshold (q-score 0-100), operator-set on the
-- agent Config page so the filter can be loosened/tightened without a redeploy.
--
-- The classifier scores each post 0-100 for reply-worthiness; a post with
-- q >= threshold is drafted ('substantial'), below it is 'light' (a short
-- supportive note) or 'skip'. NULL = use the platform default
-- (LINKEDIN_Q_THRESHOLD env, currently 75). Lowering the threshold loosens the
-- filter (more posts become drafts); raising it tightens it.

alter table noelle.agent_instances
  add column if not exists classifier_threshold integer
    check (classifier_threshold is null
           or (classifier_threshold >= 0 and classifier_threshold <= 100));
