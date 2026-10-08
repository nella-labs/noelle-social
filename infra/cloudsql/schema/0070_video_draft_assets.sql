-- 0070_video_draft_assets.sql
-- Phase 4: rendered/generated assets per video draft (Remotion overlays + images).
-- A jsonb list of VideoDraftAsset {kind, url, label?, specKind?, createdAt}.
alter table noelle.video_drafts
  add column if not exists assets jsonb not null default '[]'::jsonb;
