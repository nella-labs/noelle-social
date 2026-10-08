// Account Feeder — per-lead STYLE exemplar selection (F6 §6.4).
//
// PURPOSE: given a lead (the post the drafter is replying to) and a candidate
// pool of high-performing human style exemplars (account_style_posts, read via
// listStyleExemplars), pick a small set to inject into the drafter's SYSTEM
// prompt so the reply imitates the FORM (rhythm, hooks, sentence shape, tone) of
// real humans — NOT their content. Reusable: F8 imports this for posts
// (kind='post'); F6 uses it for replies (kind='comment').
//
// SELECTION = performance-weighted × fit, with controlled variety (§6.4 / locked
// decision 4 — "not pure-random; not best-fit-only"):
//   1. FIT — rank the pool by relevance to the lead text with Voyage rerank
//      (hybridRankStyleExemplars when NOELLE_DRAFTER_DENSE is set, else
//      rankStyleExemplars). Both fail open to the input order, so a missing
//      VOYAGE_API_KEY just degrades fit to the engagement order the pool already
//      carries — never an error.
//   2. PERFORMANCE — score each candidate by the percentile of its engagement
//      (like_count + comment_count) WITHIN the pool, 0..1.
//   3. COMBINE + SAMPLE — finalScore blends fit and performance, plus a noise
//      term whose weight is the varietyTemperature knob: 0 ⇒ deterministic
//      best-fit/best-perf, →1 ⇒ variety dominates so the chosen style varies per
//      lead. The rng is injectable (default a per-lead PRNG seeded from the lead
//      text) so it varies per lead yet is deterministic in tests.
//
// GATE: NOELLE_DRAFTER_STYLE (default OFF). FAIL-OPEN: any error, an empty pool,
// or the gate being off ⇒ returns null and the drafter behaves EXACTLY as today
// (no STYLE block). Adds NO model calls of its own beyond the single (already
// fail-open, already cost-budgeted-as-one-HTTP-call) Voyage rerank.

import { rankStyleExemplars } from "./voyageRerank.js";
import { hybridRankStyleExemplars } from "./hybridRank.js";
import { AccountFeederConfigSchema } from "@noelle/contracts";
import type { StyleExemplarRow, UltraProfileRow, PostRegister } from "./styleTypes.js";
import { corpusEngagement } from "./accountCorpusMetrics.js";

/** A chosen style exemplar (a subset of the corpus row the prompt renders). */
export interface StyleExemplar {
  /** The high-performing human text whose FORM the drafter imitates. */
  body: string;
  /** Whose voice this is (matches an ultra profile's account_handle). */
  accountHandle: string;
  likeCount: number | null;
  commentCount: number | null;
}

/** The selector's output: the chosen exemplars + the matched accounts' style notes. */
export interface StyleSelection {
  exemplars: StyleExemplar[];
  /** Prose style notes (voice/tone/structure/hooks/phrases) of the matched accounts. */
  styleNotes: string;
}

export interface SelectStyleOptions {
  /**
   * The instance's account_feeder_config jsonb. Parsed with
   * AccountFeederConfigSchema (defaults fill any missing knob). Anything that
   * fails to parse falls back to the schema defaults — never throws.
   */
  config?: unknown;
  /**
   * Force the gate on/off for tests. In production the worker passes
   * `enabled: NOELLE_DRAFTER_STYLE`. When omitted, the gate reads the
   * NOELLE_DRAFTER_STYLE env directly (truthy = on).
   */
  enabled?: boolean;
  /**
   * Use the F4b dense/hybrid ranker (hybridRankStyleExemplars) instead of the
   * F4a rerank-only path. In production the worker passes
   * `dense: NOELLE_DRAFTER_DENSE`. When omitted, reads NOELLE_DRAFTER_DENSE env.
   * (The corpus carries no precomputed embeddings here, so hybrid fails open to
   * rerank-only — this is a forward-compat hook for when 0052 backfills embeds.)
   */
  dense?: boolean;
  /** Injectable PRNG (testing). Default: a per-lead PRNG seeded from queryText. */
  rng?: () => number;
  /** Voyage API key override (forwarded to the ranker; testing/self-host). */
  apiKey?: string;
  /** Inject a fetch impl (forwarded to the ranker; testing). */
  fetchImpl?: typeof fetch;
  /**
   * The post's register (celebration | neutral). When provided, exemplar
   * selection is biased by how CHEERY each exemplar's own writing is:
   *  - celebration → pull the source's warm/hyped exemplars to the top, so the
   *    STYLE block actually teaches the cheering FORM a win deserves.
   *  - neutral → PENALIZE cheery exemplars, so an analytical reply never learns
   *    its form from "YAYYY 🥳".
   * Omitted ⇒ legacy fit×perf only (selection byte-identical to before).
   */
  postRegister?: PostRegister;
}

// How fit vs performance split the deterministic part of the score. Fit leads
// (a well-matched exemplar teaches more about the right register than a viral
// off-topic one) but performance is a strong secondary — we are learning from
// the BEST writers. varietyTemperature then trades this deterministic blend off
// against random noise.
const W_FIT = 0.6;
const W_PERF = 0.4;

// When the caller passes a postRegister, the deterministic score makes room for
// a CHEER term: how warm/hyped the exemplar's OWN writing is. Fit still leads,
// but cheer is strong enough to flip the pick toward (celebration) or away from
// (neutral) cheery exemplars. The three weights sum to 1 so the variety blend
// (which mixes this against [0,1) noise) keeps its meaning.
const W_FIT_R = 0.4;
const W_PERF_R = 0.25;
const W_CHEER_R = 0.35;

/**
 * Pick the style exemplars for one lead. See the file header for the algorithm.
 *
 * @param queryText     the lead text (the post being replied to) — the fit query
 *                      AND the default PRNG seed.
 * @param candidates    the instance's style-corpus pool (listStyleExemplars).
 * @param ultraProfiles the instance's ultra profiles (listUltraProfiles), used
 *                      to attach the matched accounts' style notes.
 * @returns the selection, or `null` when the gate is off / the pool is empty /
 *          anything errors (the drafter then drafts exactly as today).
 */
export async function selectStyleExemplars(
  queryText: string,
  candidates: StyleExemplarRow[],
  ultraProfiles: UltraProfileRow[],
  opts: SelectStyleOptions = {},
): Promise<StyleSelection | null> {
  try {
    // ── Gate ────────────────────────────────────────────────────────────────
    const enabled =
      opts.enabled !== undefined ? opts.enabled : isEnvTruthy(process.env["NOELLE_DRAFTER_STYLE"]);
    if (!enabled) return null;

    // Nothing to sample from → behave as today.
    if (!candidates || candidates.length === 0) return null;

    // ── Config knobs (defaults fill any missing key; bad config → defaults) ──
    const cfg = parseConfig(opts.config);
    const maxExemplars = cfg.maxStyleExemplars;
    if (maxExemplars <= 0) return null; // operator turned exemplars off
    const variety = clamp01(cfg.varietyTemperature);

    // ── Performance floor (defence-in-depth) ──────────────────────────────────
    // The pool query (listStyleExemplars) already applies the percentile floor
    // server-side, but re-apply it here over the pool's OWN distribution so the
    // floor is honoured even when a caller passes an unfiltered pool (e.g. a test
    // or F8). 0 = no floor. An empty result after the floor → no style.
    const pool = applyPercentileFloor(candidates, cfg.minPerformancePercentile);
    if (pool.length === 0) return null;

    // ── 1. FIT ranking ───────────────────────────────────────────────────────
    // Rerank the pool by relevance to the lead. Both rankers fail open to the
    // input order (engagement-desc), so a missing key just means "rank by perf".
    // We carry each candidate's ORIGINAL index so we can recover its rank.
    const indexed = pool.map((c, i) => ({ c, i }));
    const dense =
      opts.dense !== undefined ? opts.dense : isEnvTruthy(process.env["NOELLE_DRAFTER_DENSE"]);
    const rankerOpts = {
      ...(opts.apiKey !== undefined ? { apiKey: opts.apiKey } : {}),
      ...(opts.fetchImpl !== undefined ? { fetchImpl: opts.fetchImpl } : {}),
    };
    const ranked = dense
      ? await hybridRankStyleExemplars(queryText, indexed, {
          toText: (x) => x.c.body,
          // DENSE signal: each candidate's precomputed pgvector embedding. The
          // hybrid ranker fuses cosine-similarity over these with the rerank;
          // rows without an embedding just sit out the dense half (fail-open).
          toEmbedding: (x) => x.c.embedding ?? null,
          ...rankerOpts,
        })
      : await rankStyleExemplars(queryText, indexed, (x) => x.c.body, rankerOpts);

    // fitRank01: 1.0 for the best-fit candidate, →0 for the worst. Derived from
    // position in the reranked order. Any candidate the ranker dropped (it never
    // should) gets the worst rank.
    const fitRankByIndex = new Map<number, number>();
    ranked.forEach((x, pos) => fitRankByIndex.set(x.i, pos));
    const worstRank = pool.length; // for anything missing from `ranked`
    const denom = Math.max(1, pool.length - 1);
    const fit01 = (origIndex: number): number => {
      const pos = fitRankByIndex.get(origIndex) ?? worstRank;
      return 1 - pos / denom;
    };

    // ── 2. PERFORMANCE percentile within the pool ─────────────────────────────
    const perf01ByIndex = performancePercentiles(pool);

    // ── 3. COMBINE + SAMPLE with controlled variety ───────────────────────────
    // finalScore = (1-variety) * (W_FIT*fit + W_PERF*perf) + variety * noise.
    // variety=0 ⇒ pure fit×perf (deterministic). variety→1 ⇒ noise dominates ⇒
    // the pick varies per lead. The PRNG is seeded per-lead so it's deterministic
    // in tests yet differs across leads.
    const rng = opts.rng ?? makeSeededRng(queryText);
    const scored = pool.map((c, i) => {
      const fit = fit01(i);
      const perf = perf01ByIndex.get(i) ?? 0;
      // With a known post register, blend in a CHEER term: a celebration pulls
      // cheery exemplars up (cheerTerm = cheeriness); a neutral post pushes them
      // down (cheerTerm = 1 - cheeriness). Without a register, the legacy fit×perf
      // blend is preserved exactly.
      let deterministic: number;
      if (opts.postRegister) {
        const cheer = styleCheer01(c.body);
        const cheerTerm = opts.postRegister === "celebration" ? cheer : 1 - cheer;
        deterministic = W_FIT_R * fit + W_PERF_R * perf + W_CHEER_R * cheerTerm;
      } else {
        deterministic = W_FIT * fit + W_PERF * perf;
      }
      const noise = rng();
      const score = (1 - variety) * deterministic + variety * noise;
      return { c, score };
    });
    scored.sort((a, b) => b.score - a.score);

    const chosen = scored.slice(0, maxExemplars).map((s) => s.c);
    if (chosen.length === 0) return null;

    const exemplars: StyleExemplar[] = chosen.map((c) => ({
      body: c.body,
      accountHandle: c.account_handle,
      likeCount: c.like_count,
      commentCount: c.comment_count,
    }));

    // ── styleNotes from the matched accounts' ultra profiles ──────────────────
    const styleNotes = buildStyleNotes(chosen, ultraProfiles);

    return { exemplars, styleNotes };
  } catch {
    // FAIL-OPEN: any unexpected error ⇒ no style (draft as today). Never throw.
    return null;
  }
}

/** Parse account_feeder_config to its knobs, falling back to schema defaults. */
function parseConfig(config: unknown): {
  maxStyleExemplars: number;
  varietyTemperature: number;
  minPerformancePercentile: number;
  batchLightLeads: boolean;
} {
  // An empty object reproduces every default; a present partial overrides only
  // its set keys. A non-object / parse failure ⇒ all defaults.
  const parsed = AccountFeederConfigSchema.safeParse(
    config && typeof config === "object" ? config : {},
  );
  if (parsed.success) return parsed.data;
  return AccountFeederConfigSchema.parse({});
}

/**
 * Keep only candidates at/above the engagement percentile floor, computed over
 * the pool's OWN distribution (same rank-based percentile as the scorer). A floor
 * of 0 returns the pool unchanged. Mirrors the SQL floor in listStyleExemplars so
 * the floor is honoured even for a pool that wasn't pre-filtered.
 */
function applyPercentileFloor(
  candidates: StyleExemplarRow[],
  minPerformancePercentile: number,
): StyleExemplarRow[] {
  const floor = Math.max(0, Math.min(100, safeNum(minPerformancePercentile))) / 100;
  if (floor <= 0) return candidates;
  const pct = performancePercentiles(candidates);
  return candidates.filter((_, i) => (pct.get(i) ?? 0) >= floor);
}

/**
 * Engagement percentile (0..1) of each candidate WITHIN the pool, keyed by the
 * candidate's index. Uses a rank-based percentile so it's robust to outliers: a
 * candidate's score is (# candidates with strictly-lower engagement) / (n-1).
 * The single-element pool maps to 1 (it is trivially the top performer).
 */
function performancePercentiles(candidates: StyleExemplarRow[]): Map<number, number> {
  const measured = candidates.map((candidate, index) => ({ index,
    engagement: corpusEngagement(candidate.like_count, candidate.comment_count) }))
    .filter((item): item is { index: number; engagement: number } => item.engagement !== null);
  const n = measured.length;
  const out = new Map<number, number>();
  if (n === 0) return out;
  if (n === 1) {
    out.set(measured[0]!.index, 1);
    return out;
  }
  for (let i = 0; i < n; i++) {
    let lower = 0;
    for (let j = 0; j < n; j++) {
      if (j !== i && measured[j]!.engagement < measured[i]!.engagement) lower++;
    }
    out.set(measured[i]!.index, lower / (n - 1));
  }
  return out;
}

/**
 * Build the prose STYLE NOTES from the chosen exemplars' accounts. Dedupes by
 * account_handle (several exemplars may share an account) and renders each
 * matched ultra profile's voice/tone/structure/hooks/signature phrases compactly.
 * Returns "" when no matched profile exists (the exemplar comments still carry
 * the form on their own).
 */
function buildStyleNotes(
  chosen: StyleExemplarRow[],
  ultraProfiles: UltraProfileRow[],
): string {
  const byHandle = new Map<string, UltraProfileRow>();
  for (const p of ultraProfiles) {
    if (!byHandle.has(p.account_handle)) byHandle.set(p.account_handle, p);
  }
  const seen = new Set<string>();
  const blocks: string[] = [];
  for (const c of chosen) {
    if (seen.has(c.account_handle)) continue;
    seen.add(c.account_handle);
    const p = byHandle.get(c.account_handle);
    if (!p) continue;
    const lines: string[] = [];
    if (p.voice_summary) lines.push(`Voice: ${p.voice_summary}`);
    if (p.tone) lines.push(`Tone: ${p.tone}`);
    if (p.structure_notes) lines.push(`Structure: ${p.structure_notes}`);
    if (p.hook_patterns.length) lines.push(`Hooks: ${p.hook_patterns.slice(0, 6).join("; ")}`);
    if (p.signature_phrases.length)
      lines.push(`Signature phrasings: ${p.signature_phrases.slice(0, 6).join("; ")}`);
    if (lines.length === 0) continue;
    blocks.push(lines.join("\n"));
  }
  return blocks.join("\n\n");
}

function safeNum(v: number | null | undefined): number {
  return Number.isFinite(v) ? (v as number) : 0;
}

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(1, v));
}

// ---- Cheeriness of an exemplar's writing -----------------------------------
// A 0..1 estimate of how warm/hyped/celebratory a piece of writing is, from its
// FORM alone: exclamation density, ALL-CAPS bursts, celebratory emoji, and
// congrats/hype words. Used to bias exemplar SELECTION by post register — it
// never alters any text. Exported for direct unit testing.
const CHEER_EMOJI = /[🎉🥳🙌👏🎊🍾🔥💯✨🤩😍💕❤🥹😭]/u;
const CHEER_WORDS =
  /\b(congrats|congratulations|omg|yay+|woo+|woohoo|amazing|incredible|awesome|huge|stoked|pumped|proud|love this|so happy|so good|so excited|let'?s go+|legend|goat|killing it|crushing it|well deserved|this is huge)\b/i;

export function styleCheer01(body: string): number {
  const text = (body ?? "").trim();
  if (!text) return 0;
  const exclaims = (text.match(/!/g) ?? []).length;
  const exclaimScore = Math.min(exclaims, 3) / 3;
  const tokens = text.split(/\s+/).filter(Boolean);
  const capsTokens = tokens.filter((t) => {
    const letters = t.replace(/[^A-Za-z]/g, "");
    return letters.length >= 2 && letters === letters.toUpperCase();
  }).length;
  const capsScore = tokens.length ? Math.min((capsTokens / tokens.length) * 4, 1) : 0;
  const emojiScore = CHEER_EMOJI.test(text) ? 1 : 0;
  const wordHits = (text.match(new RegExp(CHEER_WORDS.source, "gi")) ?? []).length;
  const wordScore = Math.min(wordHits, 2) / 2;
  const raw = 0.35 * exclaimScore + 0.2 * capsScore + 0.2 * emojiScore + 0.25 * wordScore;
  return clamp01(raw);
}

function isEnvTruthy(v: string | undefined): boolean {
  if (!v) return false;
  const s = v.trim().toLowerCase();
  return s === "1" || s === "true" || s === "yes" || s === "on";
}

/**
 * A small, deterministic, seedable PRNG (mulberry32 over a string hash of the
 * seed). Same lead text ⇒ same stream (deterministic in tests); different lead
 * text ⇒ a different stream (variety across the feed). Not cryptographic — it
 * only needs to spread the variety noise.
 */
export function makeSeededRng(seed: string): () => number {
  let h = 1779033703 ^ seed.length;
  for (let i = 0; i < seed.length; i++) {
    h = Math.imul(h ^ seed.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  let a = h >>> 0;
  return function mulberry32() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
