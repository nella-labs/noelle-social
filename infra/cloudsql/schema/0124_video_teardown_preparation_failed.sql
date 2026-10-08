-- Retain truthful pre-dispatch failures without changing attempt history or permissions.
alter table noelle.video_teardown_attempts drop constraint if exists video_teardown_attempts_reason_check;
alter table noelle.video_teardown_attempts add constraint video_teardown_attempts_reason_check
  check (reason in ('generation_in_progress','operator_retry','extraction_failed','preparation_failed',
    'generation_unknown','generation_failed','completion_failed','source_changed','dispatch_uncertain'));
