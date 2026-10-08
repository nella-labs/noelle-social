/**
 * KnowledgeBase — the drafter's voice/knowledge retrieval, decoupled from Nella.
 *
 * The drafter consumes this interface directly. It is single-tenant (no
 * `workspace` arg) and provider-agnostic: the self-host default reads markdown
 * from a local directory (`createLocalFsKnowledgeBase`); managed/legacy
 * deployments wrap an existing `NellaClient` via `knowledgeBaseFromNella`.
 * Nella is now just one optional backend, not the abstraction everything is
 * shaped around.
 *
 * HYBRID DENSE LANE (opt-in, shared by every agent). The local-FS backend has
 * an optional contextualized-embedding lane (Voyage `voyage-context-4`) fused
 * with the BM25 lexical lane via RRF. Because every intern (Vega/X, Lyra/
 * LinkedIn, Orion/Reddit, and any future agent) builds its KB through this one
 * factory, flipping `NOELLE_KB_DENSE=1` on a worker upgrades that agent's
 * `kb.search()` to hybrid retrieval with zero per-agent code. It is OFF by
 * default and FAIL-OPEN at every step: with the flag unset, no Voyage key, or
 * any embed/rerank error, search is byte-identical to pure BM25. The reported
 * `KbHit.score` always stays on the BM25 scale, so the drafter's relevance gate
 * is unaffected — dense reorders and augments the result, it never moves the
 * skip bar. See docs/grounded-drafting.md.
 */

import { watch, type FSWatcher } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { buildChunkIndex, type ChunkIndex } from "./bm25Index.js";
import { buildDenseIndex, type DenseIndex } from "./denseChunkIndex.js";
import { chunkMarkdown, type MarkdownChunk } from "./markdownChunker.js";
import {
  filePathInDirs,
  scopedCandidateTopK,
  type NellaClient,
} from "./nellaClient.js";
import { rrfFuse } from "./rrf.js";
import {
  voyageContextEmbed,
  voyageContextEmbedQuery,
  type VoyageContextEmbedOptions,
} from "./voyageContextEmbed.js";
import { voyageRerank } from "./voyageRerank.js";
import { completeVoyageOrder } from "./voyageResponse.js";
import { searchResultLimit } from "./searchLimit.js";

const DEFAULT_TOP_K = 8;
const SNIPPET_WINDOW = 240;
const DEFAULT_TTL_MS = 15 * 60 * 1000;

export interface KbHit {
  snippet: string;
  score: number;
  highlights: string[];
  source: { filePath: string; startLine: number; endLine: number };
}

/** Optional scoping for a single `search` call. */
export interface KbSearchOptions {
  /**
   * Vault-subdir scoping. When non-empty, only hits whose vault-root-relative
   * `source.filePath` starts with one of these prefixes are returned
   * (case-insensitive; `foo` matches `foo/...`). Lets the drafter run two
   * passes — one scoped to VOICE dirs, one to KNOWLEDGE dirs. Absent/empty →
   * unscoped (byte-identical to a plain two-arg call).
   */
  filterDirs?: string[];
}

export interface KnowledgeBase {
  /** Top-K relevant snippets for a query. Empty query / empty corpus → []. */
  search(query: string, topK?: number, opts?: KbSearchOptions): Promise<KbHit[]>;
  /** Cheap reachability probe. */
  ready(): Promise<boolean>;
}

function snippetForChunk(chunk: MarkdownChunk, highlights: ReadonlyArray<string>): string {
  const body = chunk.body;
  if (!body) return "";
  const lower = body.toLowerCase();
  for (const tok of highlights) {
    if (!tok) continue;
    const idx = lower.indexOf(tok.toLowerCase());
    if (idx >= 0) {
      const start = Math.max(0, idx - 40);
      const end = Math.min(body.length, start + SNIPPET_WINDOW);
      return body.slice(start, end).replace(/\s+/g, " ").trim();
    }
  }
  return body.slice(0, SNIPPET_WINDOW).replace(/\s+/g, " ").trim();
}

function toKbHit(
  chunk: MarkdownChunk,
  score: number,
  highlights: ReadonlyArray<string>,
): KbHit {
  return {
    snippet: snippetForChunk(chunk, highlights),
    score,
    highlights: [...highlights],
    source: {
      filePath: chunk.filePath,
      startLine: chunk.startLine,
      endLine: chunk.endLine,
    },
  };
}

// ---------------------------------------------------------------------------
// Hybrid dense lane (Voyage voyage-context-4 ⊕ BM25, fused via RRF) — opt-in
// ---------------------------------------------------------------------------

const DEFAULT_DENSE_POOL = 50;
const DEFAULT_DENSE_MODEL = "voyage-context-4";
const DEFAULT_DENSE_DIM = 1024;
// Cap per contextualized-embed request well under Voyage's 120k-token ceiling
// (~4 chars/token ⇒ ~480k chars; 240k chars ≈ 60k tokens leaves generous slack).
const MAX_CONTEXT_EMBED_CHARS = 240_000;

/**
 * The embedder the dense lane depends on. The default wraps Voyage
 * `voyage-context-4`; tests inject a deterministic stub. Both methods are
 * fail-open by contract (return `null`/`[]` rather than throw).
 */
export interface KbDenseEmbedder {
  /**
   * Contextually embed each document's chunks together. Returns one entry per
   * input document — a `number[][]` (vector per chunk) on success, or `null`
   * for a document whose embedding failed. Length matches `documents`.
   */
  embedDocuments(documents: string[][]): Promise<Array<number[][] | null>>;
  /** Embed a single query string → its vector, or `[]` on failure. */
  embedQuery(query: string): Promise<number[]>;
}

/**
 * Opt-in configuration for the hybrid dense retrieval lane. Every field has an
 * env-backed default so a worker lights this up with one variable
 * (`NOELLE_KB_DENSE=1`) and no code change — that is what makes it shared across
 * all current and future agents.
 */
export interface KbDenseOptions {
  /** Master switch. Default: `NOELLE_KB_DENSE` env (off ⇒ pure BM25). */
  enabled?: boolean;
  /** Also run Voyage `rerank-2.5` over the fused top pool (one extra network
   * call per search, reorder-only). Default: `NOELLE_KB_DENSE_RERANK` env. */
  rerank?: boolean;
  /** RRF smoothing constant. Default 60. */
  rrfK?: number;
  /** Candidate pool fused/considered before slicing to the search topK.
   * Default: `NOELLE_KB_DENSE_POOL` env, else 50. */
  poolSize?: number;
  /** Contextualized model. Default: `NOELLE_KB_DENSE_MODEL` env, else
   * `voyage-context-4`. */
  model?: string;
  /** Output vector dimension. Default: `NOELLE_KB_DENSE_DIM` env, else 1024. */
  outputDimension?: number;
  /** Override the resolved Voyage key for the embed lane. */
  apiKey?: string;
  /** Override the contextualized-embed endpoint base. */
  endpoint?: string;
  /** Inject a fetch implementation (testing; forwarded to embed + rerank). */
  fetchImpl?: typeof fetch;
  /** Inject a full embedder (testing) — bypasses the Voyage wire entirely. */
  embedder?: KbDenseEmbedder;
}

interface ResolvedDense {
  embedder: KbDenseEmbedder;
  rerank: boolean;
  rrfK: number;
  poolSize: number;
  /** Forwarded to voyageRerank only (the rerank lane resolves its own key +
   * gateway endpoint from env, independent of the embed lane). */
  fetchImpl?: typeof fetch;
}

function envFlag(v: string | undefined): boolean {
  if (!v) return false;
  const s = v.trim().toLowerCase();
  return s === "1" || s === "true" || s === "yes" || s === "on";
}

function envPositiveInt(v: string | undefined): number | undefined {
  if (!v) return undefined;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined;
}

/**
 * Greedily pack whole documents (files) into contextualized-embed requests
 * under a char budget, never splitting a file across requests (that would
 * break the cross-chunk contextualization that is the model's whole point). A
 * batch that fails leaves its documents `null` (fail-open) rather than sinking
 * the rest of the corpus.
 */
async function embedDocumentsBatched(
  documents: string[][],
  base: VoyageContextEmbedOptions,
): Promise<Array<number[][] | null>> {
  const out: Array<number[][] | null> = new Array(documents.length).fill(null);
  let i = 0;
  while (i < documents.length) {
    const batchDocs: string[][] = [];
    const batchIdx: number[] = [];
    let chars = 0;
    while (i < documents.length) {
      const doc = documents[i]!;
      const docChars = doc.reduce((s, c) => s + c.length, 0);
      // Always take at least one document; otherwise stop when the budget is hit.
      if (batchDocs.length > 0 && chars + docChars > MAX_CONTEXT_EMBED_CHARS) break;
      batchDocs.push(doc);
      batchIdx.push(i);
      chars += docChars;
      i++;
      if (chars >= MAX_CONTEXT_EMBED_CHARS) break;
    }
    const res = await voyageContextEmbed(batchDocs, base);
    if (res.length === batchDocs.length) {
      for (let k = 0; k < batchIdx.length; k++) out[batchIdx[k]!] = res[k]!;
    }
    // else: this batch failed open ([]) — its docs stay null.
  }
  return out;
}

function defaultVoyageEmbedder(cfg: {
  model: string;
  outputDimension: number;
  apiKey?: string;
  endpoint?: string;
  fetchImpl?: typeof fetch;
}): KbDenseEmbedder {
  // Build the shared embed-option bag once (prune undefined for
  // exactOptionalPropertyTypes). Credentials are still re-resolved per call
  // inside voyageContextEmbed, so key rotation is handled.
  const base: VoyageContextEmbedOptions = {
    model: cfg.model,
    outputDimension: cfg.outputDimension,
  };
  if (cfg.apiKey !== undefined) base.apiKey = cfg.apiKey;
  if (cfg.endpoint !== undefined) base.endpoint = cfg.endpoint;
  if (cfg.fetchImpl !== undefined) base.fetchImpl = cfg.fetchImpl;
  return {
    embedDocuments: (documents) => embedDocumentsBatched(documents, base),
    embedQuery: (query) => voyageContextEmbedQuery(query, base),
  };
}

/**
 * Resolve the dense lane from explicit options merged over env defaults.
 * Returns `null` when the lane is disabled — the factory then runs the
 * unchanged pure-BM25 path. Resolved once at KB construction (matching how the
 * services read their config); per-call credential freshness lives in the
 * Voyage clients.
 */
function resolveKbDense(opts?: KbDenseOptions): ResolvedDense | null {
  const enabled = opts?.enabled ?? envFlag(process.env["NOELLE_KB_DENSE"]);
  if (!enabled) return null;

  const model = opts?.model ?? process.env["NOELLE_KB_DENSE_MODEL"] ?? DEFAULT_DENSE_MODEL;
  const outputDimension =
    opts?.outputDimension ?? envPositiveInt(process.env["NOELLE_KB_DENSE_DIM"]) ?? DEFAULT_DENSE_DIM;
  const embedder =
    opts?.embedder ??
    defaultVoyageEmbedder({
      model,
      outputDimension,
      ...(opts?.apiKey !== undefined ? { apiKey: opts.apiKey } : {}),
      ...(opts?.endpoint !== undefined ? { endpoint: opts.endpoint } : {}),
      ...(opts?.fetchImpl !== undefined ? { fetchImpl: opts.fetchImpl } : {}),
    });

  const resolved: ResolvedDense = {
    embedder,
    rerank: opts?.rerank ?? envFlag(process.env["NOELLE_KB_DENSE_RERANK"]),
    rrfK: opts?.rrfK ?? 60,
    poolSize: opts?.poolSize ?? envPositiveInt(process.env["NOELLE_KB_DENSE_POOL"]) ?? DEFAULT_DENSE_POOL,
  };
  if (opts?.fetchImpl !== undefined) resolved.fetchImpl = opts.fetchImpl;
  return resolved;
}

/** Group a flat chunk list into per-file documents (chunk bodies) plus, for
 * each document, the flat indices of its chunks. Embedding a file's chunks
 * together is what makes each vector context-aware. */
function groupChunksByFile(chunks: ReadonlyArray<MarkdownChunk>): {
  documents: string[][];
  docChunkIndices: number[][];
} {
  const documents: string[][] = [];
  const docChunkIndices: number[][] = [];
  const byFile = new Map<string, number>();
  for (let i = 0; i < chunks.length; i++) {
    const c = chunks[i]!;
    let pos = byFile.get(c.filePath);
    if (pos === undefined) {
      pos = documents.length;
      byFile.set(c.filePath, pos);
      documents.push([]);
      docChunkIndices.push([]);
    }
    documents[pos]!.push(c.body);
    docChunkIndices[pos]!.push(i);
  }
  return { documents, docChunkIndices };
}

/**
 * Embed the whole corpus (per-file, contextualized) and build the in-memory
 * dense index. Fail-open: any error ⇒ `null`, and the KB serves pure BM25.
 */
async function buildDenseForCorpus(
  chunks: ReadonlyArray<MarkdownChunk>,
  dense: ResolvedDense,
): Promise<DenseIndex | null> {
  if (chunks.length === 0) return buildDenseIndex([]);
  try {
    const { documents, docChunkIndices } = groupChunksByFile(chunks);
    const perDoc = await dense.embedder.embedDocuments(documents);
    // Visibility for the #1 silent failure: the dense lane is ENABLED and the
    // corpus is non-empty, yet the contextualized embed returned nothing. Almost
    // always a mis-pointed VOYAGE_CONTEXT_ENDPOINT (a gateway that doesn't proxy
    // /contextualizedembeddings) or a bad key — the embedder fail-opens to [] with
    // no log, so every agent quietly runs pure BM25 while believing dense is on.
    // Warn once per rebuild so it's diagnosable instead of invisible.
    if (documents.length > 0 && perDoc.length === 0) {
      console.warn(
        "[kb-dense] voyage-context-4 returned no vectors for a non-empty corpus — " +
          "the dense lane is SILENTLY falling back to BM25. Check VOYAGE_CONTEXT_ENDPOINT " +
          "(must implement /contextualizedembeddings) and VOYAGE_CONTEXT_API_KEY/VOYAGE_API_KEY.",
      );
    }
    const vectors: Array<number[] | null> = new Array(chunks.length).fill(null);
    for (let d = 0; d < documents.length; d++) {
      const docVecs = perDoc[d];
      if (!docVecs) continue;
      const idxs = docChunkIndices[d]!;
      for (let c = 0; c < idxs.length; c++) {
        const v = docVecs[c];
        if (Array.isArray(v) && v.length > 0) vectors[idxs[c]!] = v;
      }
    }
    return buildDenseIndex(vectors);
  } catch {
    return null;
  }
}

/**
 * Gate-safety guarantee for hybrid mode. Mutates `ordered` so the chunk with
 * the highest BM25 score sits within the first `topK` positions. This keeps
 * `max(KbHit.score)` over the returned hits equal to the pure-BM25 maximum, so
 * the drafter's relevance gate (which skips on `max(anchor.score) < threshold`)
 * behaves identically whether or not the dense lane is on. Dense-only chunks
 * carry score 0 and therefore can never raise — only fail to lower — the gate.
 */
function ensureTopBm25InWindow(
  ordered: number[],
  bm25Score: ReadonlyMap<number, number>,
  topK: number,
): void {
  if (ordered.length <= topK || topK < 1) return;
  let bestPos = -1;
  let bestScore = -Infinity;
  for (let p = 0; p < ordered.length; p++) {
    const s = bm25Score.get(ordered[p]!) ?? 0;
    if (s > bestScore) {
      bestScore = s;
      bestPos = p;
    }
  }
  if (bestPos < topK) return; // already inside the returned window
  const [best] = ordered.splice(bestPos, 1);
  ordered.splice(topK - 1, 0, best!);
}

/**
 * Hybrid search: fuse the BM25 lexical ranking with the dense contextualized
 * ranking (RRF), optionally rerank the fused top pool, then project to KbHits.
 *
 * Fail-open: the dense lane only adds signal. A failed query-embed yields no
 * dense ranking and the result collapses to BM25 order; a rerank error keeps
 * the fused order. The reported score is the chunk's BM25 score (0 for a
 * dense-only chunk) so the relevance gate is unaffected (see
 * `ensureTopBm25InWindow`).
 */
async function hybridSearch(
  built: BuiltIndex,
  dense: ResolvedDense,
  query: string,
  topK: number,
  filterDirs: string[] | undefined,
): Promise<KbHit[]> {
  if (!built.dense) return [];
  // Pool must be at least as wide as the pure path would scan, so hybrid never
  // sees fewer BM25 candidates (and the gate's max BM25 score is preserved).
  const pool = Math.max(dense.poolSize, scopedCandidateTopK(topK, filterDirs));

  // --- BM25 lane: keep each hit's score (for the gate) + highlights (snippet).
  const bm25 = built.index.search(query, pool);
