-- Unknown source metrics remain unknown; existing measured values are retained.
alter table noelle.account_style_posts
  alter column like_count type bigint,
  alter column like_count drop not null,
  alter column like_count drop default,
  alter column comment_count type bigint,
  alter column comment_count drop not null,
  alter column comment_count drop default,
  alter column repost_count type bigint;
