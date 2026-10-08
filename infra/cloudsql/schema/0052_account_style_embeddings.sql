-- 0052_account_style_embeddings.sql
-- Account Feeder F4b (phase 2): pgvector dense layer for the style corpus.
-- Design: docs/superpowers/specs/2026-06-19-account-feeder-design.md §7 F4b, §6.2.
--
-- Adds a dense-embedding column to the F1 style corpus (noelle.account_style_posts,
-- created in 0052_… 's predecessor 0051_account_feeder.sql) so the drafter's
-- phase-2 hybrid ranker (packages/runtime/src/hybridRank.ts) can RRF-fuse a
-- cosine-similarity dense ranking with the F4a Voyage rerank.
--
-- Embeddings are Voyage `voyage-3-large` @ 1024 dims (input_type='document').
-- They are NOT populated here: a post-deploy backfill job embeds the existing
-- corpus rows and writes this column. New rows are embedded at index time by the
-- feeder worker (F5) once the column exists. The whole dense path is dormant
-- until: (a) `create extension vector` succeeds on the target instance, (b) the
-- backfill runs, and (c) the `NOELLE_DRAFTER_DENSE` flag is turned ON (consumed
-- later by F6). With the flag OFF or the column empty, ranking fails open to the
-- F4a rerank-only path — see hybridRank.ts.
--
-- Idempotent: re-runnable. No new grant — the column lives on
-- noelle.account_style_posts, already granted to noelle_app in 0051.
--
-- Migration numbering note: `main` topped at 0051_account_feeder.sql when this
-- was authored, so 0052 is the next free slot. If a sibling session lands a
-- 0052 first, renumber this to the next free integer before merge (see PR body).

-- pgvector. Must be installed by a role with CREATE privilege (the `postgres`
-- superuser role runs migrations per docs/secrets.md; noelle_app cannot DDL).
create extension if not exists vector;

-- Dense embedding column on the style corpus. NULL until backfilled; NULL rows
-- are simply skipped by the dense ranker (it ranks only candidates that expose
-- a non-null embedding), so an un-backfilled corpus degrades to rerank-only.
alter table noelle.account_style_posts
  add column if not exists embedding vector(1024);

-- HNSW vector index for cosine-distance ANN search.
--
-- HNSW (not IVFFlat) on purpose: this migration runs BEFORE the embedding
-- backfill, so the table has zero (or NULL) vectors at index-build time. IVFFlat
-- partitions the existing vectors into `lists` clusters at build time — building
-- it on an empty/NULL column yields degenerate clusters and poor recall until a
-- manual REINDEX after the backfill. HNSW builds a graph incrementally as rows
-- are inserted/updated, so it stays correct whether the corpus is empty now or
-- grows later, with no post-backfill reindex step. HNSW also gives better
-- recall/latency at our corpus size. pgvector ≥ 0.5.0 (Cloud SQL Postgres 16
-- ships ≥ 0.7) supports `hnsw`; if a target instance predates that, swap this
-- for: create index ... using ivfflat (embedding vector_cosine_ops)
--   with (lists = 100);  -- and REINDEX after the backfill.
create index if not exists account_style_posts_embedding_idx
  on noelle.account_style_posts using hnsw (embedding vector_cosine_ops);
