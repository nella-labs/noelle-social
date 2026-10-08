/**
 * Hybrid (dense + rerank) style-exemplar ranking (Account Feeder, F4b — phase 2).
 *
 * The optional DENSE layer that sits on top of F4a's rerank. Given a query (the
 * lead) and a set of candidate style exemplars, it:
 *   1. embeds the query with Voyage `voyage-3-large` (`voyageEmbed`, query type);
 *   2. if candidates carry precomputed embeddings (`toEmbedding`), ranks them by
 *      cosine similarity to the query embedding (the pgvector DENSE signal);
 *   3. gets the F4a lexical/relevance ranking via `voyageRerank` (rerank-2.5);
 *   4. RRF-fuses the two rankings into one order;
 *   5. returns the top-`topK` candidates, reordered.
 *
 * FAIL-OPEN AT EVERY STEP — this is the load-bearing property:
 *   - no API key, no candidate embeddings, query-embed fails, or ANY error
 *     ⇒ fall back to F4a `rankStyleExemplars` (rerank-only);
 *   - if that also no-ops (no key / rerank fails open) ⇒ original candidate
 *     order, truncated to `topK`.
 * It NEVER throws. The dense layer is a pure quality lift; the drafter (F6) must
 * always get *some* ordering back. This whole module is dormant until the
 * `NOELLE_DRAFTER_DENSE` flag (read by F6) is ON and the corpus is embedded.
 *
 * Pure fusion math lives in `rrf.ts`; the two network calls live in
 * `voyageEmbed.ts` / `voyageRerank.ts`, each already fail-open by construction.
 */

import { voyageEmbed } from "./voyageEmbed.js";
import { voyageRerank, rankStyleExemplars } from "./voyageRerank.js";
import { rrfFuse, cosineSim } from "./rrf.js";
import { completeVoyageOrder, voyageTopK } from "./voyageResponse.js";

export type HybridRankOptions<T> = {
  /** Project a candidate to the text used for the rerank (and as the embed
   * fallback corpus text, though dense uses precomputed embeddings). Required. */
  toText: (c: T) => string;
  /** Project a candidate to its precomputed embedding (e.g. the pgvector
   * `embedding` column). Return `null`/`undefined` for rows not yet embedded.
   * If omitted, or if it yields nothing usable, the dense layer is skipped and
   * ranking falls back to rerank-only. */
  toEmbedding?: (c: T) => number[] | null | undefined;
  /** Return only the top-K candidates. Defaults to all. */
  topK?: number;
  /** RRF smoothing constant (forwarded to `rrfFuse`). Default 60. */
  rrfK?: number;
  /** Override `VOYAGE_API_KEY` (forwarded to both Voyage calls). */
  apiKey?: string;
  /** Override the Voyage gateway base URL (forwarded to both Voyage calls). */
  endpoint?: string;
  /** Caller abort signal (forwarded to both Voyage calls). */
  signal?: AbortSignal;
  /** Inject a fetch implementation (testing; forwarded to both Voyage calls). */
  fetchImpl?: typeof fetch;
};

/**
 * Rank `candidates` by hybrid (dense ⊕ rerank) fit to `query`, returning the
 * candidate objects reordered best-first (length ≤ `topK`).
 *
 * @returns the reordered candidates. Falls back to F4a rerank-only, then to the
 *          original order, on any missing-signal or error condition. Never throws.
 */
export async function hybridRankStyleExemplars<T>(
  query: string,
  candidates: T[],
  opts: HybridRankOptions<T>,
): Promise<T[]> {
  const topK = voyageTopK(candidates.length, opts.topK);
  if (topK === 0) return [];

  const { toText, toEmbedding } = opts;

  // Build the shared option bag forwarded to the underlying Voyage calls.
  // Spread-then-prune keeps `undefined` off keys under exactOptionalPropertyTypes.
  const voyageOpts: {
    apiKey?: string;
    endpoint?: string;
    signal?: AbortSignal;
    fetchImpl?: typeof fetch;
  } = {};
  if (opts.apiKey !== undefined) voyageOpts.apiKey = opts.apiKey;
  if (opts.endpoint !== undefined) voyageOpts.endpoint = opts.endpoint;
  if (opts.signal !== undefined) voyageOpts.signal = opts.signal;
  if (opts.fetchImpl !== undefined) voyageOpts.fetchImpl = opts.fetchImpl;

  // The F4a fallback used whenever the dense layer can't contribute or anything
  // throws. `rankStyleExemplars` itself fails open to input order.
  const rerankOnly = (): Promise<T[]> =>
    rankStyleExemplars(query, candidates, toText, { ...voyageOpts, topK });

  try {
    // --- Dense candidate embeddings (precomputed) -------------------------
    // Collect the candidate indices that actually carry a usable embedding.
    const denseEmbeddings: Array<number[] | null> = candidates.map((c) => {
      const e = toEmbedding ? toEmbedding(c) : null;
      return Array.isArray(e) && e.length > 0 ? e : null;
    });
    const hasAnyDense = denseEmbeddings.some((e) => e !== null);

    // No precomputed embeddings at all ⇒ dense layer can't help ⇒ rerank-only.
    if (!hasAnyDense) return await rerankOnly();

    // --- Query embedding --------------------------------------------------
    // Voyage `voyage-3-large`, query side. Fails open to [] (no key / error).
    const queryEmbeds = await voyageEmbed([query], { ...voyageOpts, inputType: "query" });
    const queryVec = queryEmbeds[0];
    // No query vector ⇒ no dense signal ⇒ rerank-only.
    if (!queryVec || queryVec.length === 0) return await rerankOnly();

    // --- Dense ranking (cosine similarity), descending --------------------
    const denseScored: Array<{ index: number; score: number }> = [];
    for (let i = 0; i < denseEmbeddings.length; i++) {
      const emb = denseEmbeddings[i];
      if (emb === null || emb === undefined) continue;
      denseScored.push({ index: i, score: cosineSim(queryVec, emb) });
    }
    denseScored.sort((a, b) => b.score - a.score);
    const denseRanking = denseScored.map((d) => d.index);

    // --- Rerank ranking (F4a lexical/relevance) ---------------------------
    const documents = candidates.map(toText);
    const reranked = await voyageRerank(query, documents, { ...voyageOpts });
    const rerankRanking = reranked.map((r) => r.index);

    // --- RRF fuse the two rankings ----------------------------------------
    const fused = rrfFuse(
      [denseRanking, rerankRanking],
      { ...(opts.rrfK !== undefined ? { k: opts.rrfK } : {}) },
    );

    // Project fused indices back onto candidate objects. `fused` only contains
    // indices seen in the inputs (all in-bounds), but guard for safety under
    // noUncheckedIndexedAccess.
    const reordered: T[] = [];
    for (const idx of completeVoyageOrder(fused, candidates.length)) {
      const c = candidates[idx];
      if (c !== undefined) reordered.push(c);
    }
    // Defensive: if fusion somehow produced nothing, fall back rather than [].
    if (reordered.length === 0) return await rerankOnly();

    return reordered.slice(0, topK);
  } catch {
    // Any unexpected error anywhere in the hybrid path ⇒ F4a rerank-only,
    // which itself fails open to input order. Never throw.
    try {
      return await rerankOnly();
    } catch {
      // Truly last-ditch: original order (truncated), never throw.
      return candidates.slice(0, topK);
    }
  }
}
