// Semantic grounding retrieval — optional Voyage rerank over the BM25 anchors.
//
// The knowledge base (voice + knowledge vault) ranks lexically (BM25/MiniSearch).
// That misses semantically-relevant anchors that don't share keywords with the
// post. retrieveAnchors adds an OPTIONAL second stage: pull a WIDER BM25 pool,
// then rerank it to the final topK with Voyage rerank-2.5 (the same model the
// style selector uses), so the drafter grounds on the most RELEVANT anchors, not
// just keyword hits.
//
// GATE: rerank=false (default) → byte-identical to a plain kb.search(query, topK).
// FAIL-OPEN: the reranker (voyageRerank, via rankStyleExemplars) returns the
// input order on any failure (no key, network, non-2xx), so a missing
// VOYAGE_API_KEY just degrades to the BM25 order — never an error, never a throw.

import { rankStyleExemplars, type KbHit, type KnowledgeBase } from "@noelle/runtime";

export interface RetrieveAnchorsOptions {
  /** Final number of anchors to return. */
  topK: number;
  /** Vault-subdir scoping (voice dirs / knowledge dirs). */
  filterDirs?: string[];
  /** Turn the Voyage rerank stage on. Off ⇒ plain BM25 kb.search (today). */
  rerank?: boolean;
  /** BM25 pool = topK × this (capped), the candidate set the rerank reorders. */
  poolMultiplier?: number;
  /** Voyage key override (tests / explicit wiring). Falls back to env. */
  apiKey?: string;
  /** Inject fetch (tests). */
  fetchImpl?: typeof fetch;
}

/** Hard cap on the BM25 candidate pool, to bound the rerank payload + cost. */
const MAX_POOL = 40;

/**
 * Retrieve grounding anchors for a query, optionally Voyage-reranked. With
 * rerank off it is exactly `kb.search(query, topK, {filterDirs})`. With rerank
 * on it pulls a wider pool and reorders it by semantic fit, returning the topK.
 */
export async function retrieveAnchors(
  kb: Pick<KnowledgeBase, "search">,
  query: string,
  opts: RetrieveAnchorsOptions,
): Promise<KbHit[]> {
  const { topK, filterDirs, rerank } = opts;
  const searchOpts = filterDirs && filterDirs.length ? { filterDirs } : undefined;
  if (!rerank || topK <= 0) {
    return kb.search(query, topK, searchOpts);
  }

  const poolN = Math.min(Math.max(topK * (opts.poolMultiplier ?? 3), topK), MAX_POOL);
  const pool = await kb.search(query, poolN, searchOpts);
  // Nothing to narrow — return as-is (a rerank of ≤topK items can't change which
  // items survive, only their order, which the drafter doesn't depend on).
  if (pool.length <= topK) return pool;

  const reranked = await rankStyleExemplars(query, pool, (h) => h.snippet, {
    topK,
    ...(opts.apiKey !== undefined ? { apiKey: opts.apiKey } : {}),
    ...(opts.fetchImpl !== undefined ? { fetchImpl: opts.fetchImpl } : {}),
  });
  // Defensive: a reranker that somehow returned nothing ⇒ fall back to BM25 topK.
  return reranked.length ? reranked : pool.slice(0, topK);
}
