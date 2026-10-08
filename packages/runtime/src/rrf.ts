/**
 * Reciprocal Rank Fusion + cosine similarity (Account Feeder, F4b — phase 2).
 *
 * Pure, side-effect-free helpers (no I/O, no env, no network) used by
 * `hybridRank.ts` to fuse a dense (pgvector cosine) ranking with the F4a Voyage
 * rerank ranking into a single order.
 *
 * RRF (Cormack et al., 2009) fuses N rankings of the SAME item set without
 * needing comparable scores across rankers: each item's fused score is the sum
 * over rankings of `1 / (k + rank)`, where `rank` is the item's 0-based position
 * in that ranking and `k` is a smoothing constant (default 60, the canonical
 * value). Items absent from a ranking simply contribute 0 from it. Higher fused
 * score = better; we return indices sorted best-first.
 */

/**
 * Fuse several rankings (each a list of item indices, best-first) into one
 * index order via Reciprocal Rank Fusion.
 *
 * Each input ranking is an array of indices into some shared candidate list —
 * e.g. `[2, 0, 1]` means "item 2 is best, then 0, then 1". Rankings may be
 * partial (omit some indices) and may have different lengths; an item missing
 * from a ranking just earns 0 from it.
 *
 * @param rankings  one index-list per ranker (dense, rerank, …), each best-first.
 * @param opts.k    RRF smoothing constant. Default 60.
 * @returns the fused list of indices, best-first. Deterministic: ties break by
 *          ascending index so the output is stable. The union of all indices
 *          seen across the input rankings (deduped) is returned.
 */
export function rrfFuse(
  rankings: number[][],
  opts?: { k?: number },
): number[] {
  const k = opts?.k ?? 60;

  // Accumulate fused score per item index across all rankings.
  const scores = new Map<number, number>();
  for (const ranking of rankings) {
    for (let rank = 0; rank < ranking.length; rank++) {
      const idx = ranking[rank];
      // Guard for noUncheckedIndexedAccess; skip junk indices defensively.
      if (idx === undefined || !Number.isFinite(idx)) continue;
      const contribution = 1 / (k + rank);
      scores.set(idx, (scores.get(idx) ?? 0) + contribution);
    }
  }

  // Best-first; deterministic tie-break by ascending index.
  return [...scores.keys()].sort((a, b) => {
    const sa = scores.get(a) ?? 0;
    const sb = scores.get(b) ?? 0;
    if (sb !== sa) return sb - sa;
    return a - b;
  });
}

/**
 * Cosine similarity of two equal-length numeric vectors, in `[-1, 1]`.
 *
 * Returns 0 for mismatched lengths, empty vectors, or a zero-magnitude vector
 * (no direction to compare) — these are "no signal" cases, never an exception,
 * to keep the dense ranker fail-soft at the math layer too.
 */
export function cosineSim(a: number[], b: number[]): number {
  const n = a.length;
  if (n === 0 || n !== b.length) return 0;

  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < n; i++) {
    const ai = a[i] ?? 0;
    const bi = b[i] ?? 0;
    dot += ai * bi;
    normA += ai * ai;
    normB += bi * bi;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}
