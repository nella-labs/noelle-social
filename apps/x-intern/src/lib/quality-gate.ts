// Heuristic quality gate. The openclaw version compared candidate drafts
// against scraped comment threads via Vertex; Noelle v1 doesn't fetch
// comments (out of scope, spec § 5), so we score on intrinsic signals:
// length, lint cleanliness, presence of a concrete hook, t.co-aware char
// validity. Returns a 0–100 score.

import { lint, charCountX } from "./voice.js";

export interface QualityGateInput {
  postText: string;
  draftText: string;
  authorHandle?: string;
}

export interface QualityGateResult {
  score: number;          // 0..100
  passes_cutoff: boolean;
  cutoff_used: number;
  reasoning: string;
}

const DEFAULT_CUTOFF = Number(process.env.WATCHLIST_QUALITY_CUTOFF ?? 80);

export async function qualityGate(input: QualityGateInput): Promise<QualityGateResult> {
  let score = 60;
  const reasons: string[] = [];

  const cc = await charCountX(input.draftText);
  if (!cc.isValid) {
    reasons.push("over-280-chars");
    score -= 30;
  } else if (cc.count >= 80 && cc.count <= 240) {
    score += 10;
    reasons.push("ok-length");
  }

  const l = await lint(input.draftText);
  if (l.ok) {
    score += 15;
    reasons.push("lint-clean");
  } else {
    score -= 5 * Math.min(l.violations.length, 4);
    reasons.push(`lint-${l.violations.length}`);
  }

  // Topical connection check — does the draft reference any 4+ char word
  // from the lead's post? Cheap proxy for "actually relevant".
  const postTokens = new Set(
    input.postText.toLowerCase().match(/[a-z]{4,}/g) ?? [],
  );
  const draftTokens = input.draftText.toLowerCase().match(/[a-z]{4,}/g) ?? [];
  const overlap = draftTokens.some((t) => postTokens.has(t));
  if (overlap) {
    score += 15;
    reasons.push("topical");
  } else {
    score -= 10;
    reasons.push("no-topical-overlap");
  }

  score = Math.max(0, Math.min(100, score));
  return {
    score,
    passes_cutoff: score >= DEFAULT_CUTOFF,
    cutoff_used: DEFAULT_CUTOFF,
    reasoning: reasons.join(", "),
  };
}
