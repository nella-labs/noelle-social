/**
 * In-memory DENSE index over chunk vectors — the cosine-similarity counterpart
 * to `bm25Index.ts`'s lexical index.
 *
 * Given one embedding vector per chunk (positionally aligned to the chunk
 * array; `null` for chunks that weren't embedded), `search(queryVec, topK)`
 * returns chunk indices ranked by cosine similarity to the query, best-first.
 * The KnowledgeBase RRF-fuses this ranking with the BM25 ranking so a chunk
 * that's semantically on-topic but shares no literal tokens with the query
 * (paraphrase, synonym) still surfaces.
 *
 * Pure, side-effect-free (no I/O, no env, no network). Cosine math is reused
 * from `rrf.ts` so the dense ranker stays fail-soft at the math layer too
 * (mismatched lengths / zero-magnitude vectors score 0 rather than throwing).
 */

import { cosineSim } from "./rrf.js";
import { searchResultLimit } from "./searchLimit.js";

/** A single dense hit: `index` into the chunk array, with its cosine score. */
export interface DenseResult {
  index: number;
  score: number;
}

export interface DenseIndex {
  /**
   * Chunk indices ranked by cosine similarity to `queryVec`, best-first,
   * length ≤ `topK`. Empty query, no embedded chunks, or `topK <= 0` → [].
   * Ties break by ascending index for deterministic, stable output.
   */
  search(queryVec: number[], topK: number): ReadonlyArray<DenseResult>;
}

/**
 * Build a dense index from `vectors`, where `vectors[i]` is the embedding for
 * chunk `i` (or `null`/`undefined` if that chunk has no embedding). Chunks
 * without a vector are simply never returned.
 */
export function buildDenseIndex(
  vectors: ReadonlyArray<number[] | null | undefined>,
): DenseIndex {
  // Snapshot the embedded chunks once (index + vector), skipping holes.
  const embedded: Array<{ index: number; vec: number[] }> = [];
  for (let i = 0; i < vectors.length; i++) {
    const v = vectors[i];
    if (Array.isArray(v) && v.length > 0) embedded.push({ index: i, vec: v });
  }

  return {
    search(queryVec, topK) {
      topK = searchResultLimit(topK, embedded.length);
      if (topK === 0 || queryVec.length === 0) return [];
      const scored = embedded.map((e) => ({
        index: e.index,
        score: cosineSim(queryVec, e.vec),
      }));
      // Best-first; deterministic tie-break by ascending index.
      scored.sort((a, b) => (b.score !== a.score ? b.score - a.score : a.index - b.index));
      return scored.slice(0, topK);
    },
  };
}
