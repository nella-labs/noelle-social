-- 0068_video_embeddings.sql
-- Nova Phase 2: pgvector dense layer for the harvested clip corpus, mirroring the
-- account-feeder F4b layer (0052_account_style_embeddings.sql). The distiller
-- (W3) embeds each clip's caption+transcript with Voyage `voyage-3-large` @ 1024
-- dims so the studio's exemplar retrieval (Phase 3 selectVideoExemplars) can rank
-- by semantic fit. NOT populated here — the distiller backfills NULL rows.
--
-- Idempotent. No new grant (column lives on noelle.video_clips, granted in 0065).
-- pgvector is installed by the superuser running migrations.
--
-- Numbering: main topped at 0067 (Nova studio) when authored; if a sibling lands
-- 0068 first, renumber to the next free integer before merge.

create extension if not exists vector;

alter table noelle.video_clips
  add column if not exists embedding vector(1024);

-- HNSW (not IVFFlat): the column is empty/NULL at build time and the distiller
-- backfills incrementally, so a graph index stays correct without a post-backfill
-- reindex. Mirrors 0052.
create index if not exists video_clips_embedding_idx
  on noelle.video_clips using hnsw (embedding vector_cosine_ops);
