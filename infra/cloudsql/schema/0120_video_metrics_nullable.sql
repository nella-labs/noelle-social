-- Unknown source counters remain null; historical measured values are retained.
alter table noelle.video_clips
  alter column views drop not null, alter column views drop default,
  alter column likes drop not null, alter column likes drop default,
  alter column comments drop not null, alter column comments drop default,
  alter column shares drop not null, alter column shares drop default,
  alter column saves drop not null, alter column saves drop default;
alter table noelle.video_clip_metrics
  alter column views drop not null, alter column views drop default,
  alter column likes drop not null, alter column likes drop default,
  alter column comments drop not null, alter column comments drop default,
  alter column shares drop not null, alter column shares drop default,
  alter column saves drop not null, alter column saves drop default;
