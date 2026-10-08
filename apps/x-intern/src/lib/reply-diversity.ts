// Reply-diversity gate for OUTBOUND X replies.
//
// Templated / near-identical replies are a shadowban vector on X even with clean
// pacing: the same reply shape sent again and again reads as a bot. This gate is
// the last check before a reply is queued for approval. It combines two signals:
//
//  1. Near-duplicate: character-trigram Jaccard similarity against the account's
//     recently-sent replies. Character trigrams are robust to small edits and
//     word reordering, so a lightly reworded repeat still scores high.
//  2. AI-slop: the existing deterministic detector (ai-slop.ts), reused here on
//     our OWN outgoing text (it was built to grade incoming posts).
//
// Pure, deterministic, no I/O. The caller supplies the recent-send corpus.

import { detectAiSlop } from "./ai-slop.js";

export function normalize(text: string): string {
  return (text ?? "").toLowerCase().replace(/\s+/g, " ").trim();
}

/** Character 3-grams of the normalized text. */
export function trigrams(text: string): Set<string> {
  const s = normalize(text);
  const g = new Set<string>();
  for (let i = 0; i + 3 <= s.length; i++) g.add(s.slice(i, i + 3));
  return g;
}

/** Jaccard similarity of two trigram sets (1 = identical, 0 = disjoint). */
export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

/** Max trigram-Jaccard similarity, with exact comparison for short replies. */
export function maxSimilarity(text: string, priors: string[]): number {
  const normalized = normalize(text);
  const t = trigrams(text);
  let max = 0;
  for (const p of priors) {
    const prior = trigrams(p);
    // Empty trigram sets cannot distinguish two different short replies.
    const sim = t.size === 0 || prior.size === 0
      ? Number(normalized === normalize(p))
      : jaccard(t, prior);
    if (sim > max) max = sim;
  }
  return max;
}

export interface ReplyGateResult {
  ok: boolean;
  reason?: "near-duplicate" | "ai-slop";
  /** Max trigram-Jaccard similarity against the recent-send corpus. */
  similarity: number;
  slopScore: number;
  slopReasons: string[];
}

export interface ReplyGateOpts {
  /** Recently-sent reply bodies for this account (the dedup corpus). */
  priors: string[];
  /** Similarity at/above which a reply is a near-duplicate. Default 0.5. */
  simThreshold?: number;
}

/**
 * Gate an outbound reply body. Returns ok=false with a reason when the reply is
 * too similar to a recent send or reads as AI-slop, so the caller can regenerate,
 * skip, or flag it before it is queued for approval.
 */
export function gateReply(text: string, opts: ReplyGateOpts): ReplyGateResult {
  const simThreshold = opts.simThreshold ?? 0.5;
  const similarity = maxSimilarity(text, opts.priors ?? []);
  const slop = detectAiSlop(text);
  if (similarity >= simThreshold) {
    return { ok: false, reason: "near-duplicate", similarity, slopScore: slop.score, slopReasons: slop.reasons };
  }
  if (slop.isSlop) {
    return { ok: false, reason: "ai-slop", similarity, slopScore: slop.score, slopReasons: slop.reasons };
  }
  return { ok: true, similarity, slopScore: slop.score, slopReasons: slop.reasons };
}
