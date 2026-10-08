// Account Feeder — shared style-corpus row shapes + post register. These are the
// platform-agnostic types the style selector (styleSelect.ts) and renderer
// (styleBlock.ts) consume. The per-intern DB loaders (Lyra's account-feeder-db,
// Vega's x-account-feeder-db) RETURN these shapes, so the one definition here is
// the single source of truth shared by both interns via @noelle/runtime.

/** A post's register: a celebration (win/launch/milestone) vs a neutral post. */
export type PostRegister = "celebration" | "neutral";

/**
 * One style-corpus exemplar as the DRAFTER consumes it (reply style injection;
 * the post drafter reuses it). A flat, columnar row — `body` is the text the
 * drafter imitates, the counts are the performance signal, `account_handle` names
 * whose voice it is (so the matched ultra profile can be looked up).
 */
export interface StyleExemplarRow {
  external_id: string;
  body: string;
  like_count: number | null;
  comment_count: number | null;
  account_handle: string;
  posted_at: string | null;
  /**
   * The pgvector `embedding` (1024d voyage-3-large), or null when the row hasn't
   * been embedded yet. Carries the DENSE signal the hybrid ranker fuses with the
   * rerank — selectStyleExemplars passes it through via `toEmbedding`.
   */
  embedding?: number[] | null;
}

/** One account's extracted ultra profile, as the drafter's STYLE notes consume it. */
export interface UltraProfileRow {
  account_handle: string;
  voice_summary: string | null;
  tone: string | null;
  structure_notes: string | null;
  hook_patterns: string[];
  signature_phrases: string[];
  top_topics: string[];
}
