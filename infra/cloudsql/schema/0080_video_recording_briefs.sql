-- 0080_video_recording_briefs.sql
-- Nova's "briefer" (W6): a phone-readable RECORDING BRIEF for an operator-approved
-- video_draft (status='ready'). Realizes the never-deployed Paperclip media-intern
-- capability inside the live Nova pipeline: a prep artifact carrying a hook check,
-- shot list, b-roll, cam angles, props/setting, a runtime target, and an
-- "On-the-day notes" section whose flagged items roll up into `forge_followups`
-- (a plain integer + per-note flags a later Forge skill can consume — no Forge
-- integration is built here). See docs/superpowers/specs/2026-07-03-media-intern-recording-brief-design.md.
--
-- One brief per draft (UNIQUE draft_id): shards can't double-write; a manual
-- "Regenerate brief" overwrites. The briefer only READS 'ready' drafts and WRITES
-- this table — it cannot corrupt the ideas->drafts pipeline. Flag-gated by
-- NOELLE_BRIEFER (default OFF), so this table is dormant until enabled.

create table if not exists noelle.video_recording_briefs (
  id                uuid        primary key default gen_random_uuid(),
  org_id            uuid        not null references noelle.organizations(id) on delete cascade,
  agent_instance_id uuid        not null references noelle.agent_instances(id) on delete cascade,
  draft_id          uuid        not null references noelle.video_drafts(id) on delete cascade,
  idea_id           uuid        not null references noelle.video_ideas(id) on delete cascade,
  platform          text        not null default 'instagram',
  runtime_target    integer,                                          -- target runtime in SECONDS (null = model gave none)
  brief             jsonb       not null default '{}'::jsonb,         -- RecordingBriefOutput (structured; the renderer's source)
  brief_md          text        not null default '',                 -- phone-first markdown (<=600 words) the operator reads on set
  forge_followups   integer     not null default 0,                  -- COUNT of onTheDayNotes where forgeWouldHelp (deterministic, not LLM-authored)
  source_engine     text,                                            -- provenance: claude | bedrock | vertex
  model             text,
  status            text        not null default 'ready',            -- ready|dismissed (brief lifecycle; independent of the draft's)
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

-- Studio read surface: "latest briefs for this instance".
create index if not exists video_recording_briefs_instance_created_idx
  on noelle.video_recording_briefs (agent_instance_id, created_at desc);

-- One brief per draft. The briefer's existence guard (LEFT JOIN ... IS NULL) keeps
-- a second tick from re-claiming; this UNIQUE index is the hard backstop so two
-- shards racing the same 'ready' draft can't both write, and a regenerate is an
-- overwrite (insert ... on conflict (draft_id) do update).
create unique index if not exists video_recording_briefs_draft_uidx
  on noelle.video_recording_briefs (draft_id);

grant select, insert, update, delete on noelle.video_recording_briefs to noelle_app;

drop trigger if exists video_recording_briefs_set_updated_at on noelle.video_recording_briefs;
create trigger video_recording_briefs_set_updated_at
  before update on noelle.video_recording_briefs
  for each row execute function noelle.tg_set_updated_at();
