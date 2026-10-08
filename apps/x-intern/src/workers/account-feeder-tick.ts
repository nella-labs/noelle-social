import { computePerfRollup } from "@noelle/runtime/account-feeder-db";
export { computePerfRollup } from "@noelle/runtime/account-feeder-db";
import { readSourceCount } from "@noelle/runtime/source-values";
import { z } from "zod";
import type { Logger } from "../lib/logger.js";
import { X_SCRAPER_ACTOR, ApifyXError, type ApifyXClient } from "@noelle/x-apify";
import { batchMap, type SpendRecorder } from "@noelle/runtime";
import { withMeteredApifyCall } from "../lib/apify-receipts.js";
import type { EngineBackend } from "@noelle/runtime";
import type {
  FeederInstance,
  FeederSource,
  StylePostUpsert,
  StylePostEmbedding,
  CorpusItem,
  AccountUltraProfileUpsert,
} from "../lib/x-account-feeder-db.js";

// The X (Vega) Account Feeder's per-run orchestration. Ported from Lyra's
// account-feeder-tick.ts (poll → Apify pull → Gemini extract → direct-SQL
// upsert), adapted to X's single-timeline read:
//
//   1. For each enabled source account:
//        a. userTweets → one Apify call over the `from:` search returns the
//           account's recent originals AND authored replies. Split by is_reply
//           into account_style_posts kind='post' / kind='comment' (drop reposts).
//        (meter the Apify run; stamp last_pulled_at)
//   2. Fan out (batchMap) ONE Gemini style-extractor per source account →
//      upsert account_ultra_profiles (+ perf rollup from the columnar counts).
//   3. Voyage dense-embed the corpus (backfill + newly pulled) for the F4b ranker.
//
// CRITICAL INVARIANTS:
//   (i)  Source tweets go ONLY into account_style_posts — NEVER noelle.leads.
//        They are style exemplars, not reply targets.
//   (ii) Apify 402 (usage cap) / 429 (concurrency) — and "all tokens exhausted"
//        — SURFACE to the operator (a bus event + an errored worker_runs row),
//        NOT swallowed. A cost-gated manual pull must tell the operator it hit
//        the wall.
//   (iii) Fail-open per unit: one source erroring (non-quota) doesn't abort the
//        run; one Gemini extraction failing doesn't lose the already-stored
//        corpus (corpus rows persist; only that account's ultra profile is skipped).

export const STYLE_EXTRACTOR_MODEL = "gemini-2-5-flash";

// One extraction distils a full style profile from ~60 posts — a large, slow
// generation. The Gemini-key backend's 8 s default aborts it every time
// ("This operation was aborted" → 0 profiles written). Give the extractor real
// headroom; it's a manual, low-frequency, one-call-per-source operation.
export const STYLE_EXTRACTOR_TIMEOUT_MS = 90_000;

/**
 * The style-extraction SYSTEM prompt. Ported verbatim from Lyra's
 * lib/prompts.ts SYSTEM_STYLE_EXTRACTOR — only the platform noun (LinkedIn → X)
 * changes; the strict-JSON schema + no-fabrication rules are identical, so the
 * extracted ultra profile has the exact shape UltraProfileOutput expects.
 */
export const SYSTEM_STYLE_EXTRACTOR = [
  "You analyze the posts and replies from ONE X (Twitter) account and extract that account's writing STYLE so another writer can imitate it.",
  "You are NOT summarizing what the account is about and you are NOT profiling who they are — you are reverse-engineering HOW they write: their voice, tone, the structural patterns of their posts, the hook patterns they open with, the signature phrases/words they reuse, and the topics they write about.",
  "Ground EVERYTHING ONLY in the provided text. DO NOT invent, fabricate, or guess voice traits, phrases, hooks, or topics that are not clearly present in the samples. If the sample is thin or one-note, return fewer items rather than padding — an empty list is better than a made-up one. Never attribute a phrase the account did not actually use.",
  "Output STRICT JSON, no preamble, no markdown fences. The first character MUST be `{` and the last `}`:",
  '  {"voice_summary":"2-4 sentences on how this account writes (register, posture, what makes the voice recognizable)","tone":"a few adjectives for the tone (e.g. dry, punchy, earnest, contrarian, technical)","structure_notes":"how their posts/replies are structured — length, line breaks, lists vs prose, openers, closers, cadence","hook_patterns":["recurring ways they open a post / grab attention, quoted or paraphrased from the samples"],"signature_phrases":["distinctive words or phrasings they actually reuse"],"top_topics":["the themes they write about, lowercase"]}',
  "Each list holds at most 8 short, concrete items drawn from the samples. Keep `voice_summary`/`tone`/`structure_notes` tight — this is an imitation cheat-sheet, not an essay.",
].join(" ");

const DEFAULT_POST_LIMIT = 40;
const DEFAULT_COMMENT_LIMIT = 40;
const DEFAULT_CONCURRENCY = 4;
// Cap the corpus text fed to one extractor so a prolific account can't blow the
// prompt; most-engaged items are kept first (getAccountCorpus orders by likes).
const DEFAULT_CORPUS_FOR_EXTRACT = 60;
// Per-tick cap on corpus rows to dense-embed (one-time backfill + newly pulled).
// Bounded so a huge corpus can't make a single run unbounded; the next run picks
// up the remainder.
const EMBED_MAX_PER_TICK = 512;
// Texts per Voyage embed HTTP call.
const EMBED_CHUNK = 64;

// gemini-2-5-flash is shape-wobbly on these: it frequently returns `tone` (and
// sometimes the other prose fields) as an ARRAY of adjectives, and occasionally a
// list field as a bare string. `.default()` only fills a MISSING key, so a
// present-but-wrong-typed field would fail the WHOLE profile (dropping a perfectly
// good extraction). Coerce instead: array → joined string for the prose fields, a
// bare string → a 1-item list for the list fields.
const flexString = z.preprocess(
  (v) => (Array.isArray(v) ? v.filter((x) => typeof x === "string").join(", ") : v),
  z.string().default(""),
);
const flexStringArray = z.preprocess(
  (v) => (typeof v === "string" ? [v] : v),
  z.array(z.string()).max(20).default([]),
);

/** The extractor's strict-JSON output (parsed with extractJson→Zod, fail-open). */
export const UltraProfileOutput = z.object({
  voice_summary: flexString,
  tone: flexString,
  structure_notes: flexString,
  hook_patterns: flexStringArray,
  signature_phrases: flexStringArray,
  top_topics: flexStringArray,
});
export type UltraProfileOutputT = z.infer<typeof UltraProfileOutput>;

/** Pull + corpus-write deps (the Apify client + the corpus upsert seam). */
export interface FeederTickDeps {
  log: Logger;
  instance: FeederInstance;
  sources: FeederSource[];
  /** Apify X client — only the one read method the feeder needs. */
  apify: Pick<ApifyXClient, "userTweets" | "drainLastRunUsd" | "drainRunReceipts" | "isolateOperation">;
  /** Gemini backend — one call per source for style extraction. */
  extractor: Pick<EngineBackend, "call">;
  /** Idempotent corpus upsert (account_style_posts). Returns rows written. */
  upsertStylePosts: (rows: StylePostUpsert[]) => Promise<number>;
  /** Read a source's stored corpus back for extraction. */
  getCorpus: (args: {
    agentInstanceId: string;
    platform: string;
    accountHandle: string;
    limit: number;
  }) => Promise<CorpusItem[]>;
  /** Upsert one account's ultra profile (account_ultra_profiles). */
  upsertUltraProfile: (p: AccountUltraProfileUpsert) => Promise<void>;
  /** Stamp last_pulled_at on a source after its pull. */
  markSourcePulled: (sourceId: string) => Promise<void>;
  /**
   * Dense-embed a batch of texts (Voyage voyage-3-large, 1024d). Omit to skip
   * the embed pass entirely (byte-identical to pre-dense behavior). Fail-open:
   * an empty result means "no embeddings available" and the pass is skipped.
   */
  embed?: (texts: string[]) => Promise<number[][]>;
  /** Corpus rows for this instance still missing an embedding (capped). */
  listUnembeddedStylePosts?: (instanceId: string, limit: number) => Promise<Array<{ id: string; body: string }>>;
  /** Persist embeddings only for the exact captured corpus body. */
  updateStylePostEmbeddings?: (rows: StylePostEmbedding[]) => Promise<number>;
  postLimit?: number;
  commentLimit?: number;
  concurrency?: number;
  /** Meters each Apify actor run into llm_calls (engine='apify'). Omit to skip. */
  recorder?: SpendRecorder;
  /** noelle.connections id of the Apify token used, stamped on spend rows. */
  credentialId?: string | null;
}

export interface FeederTickResult {
  /** Source accounts whose corpus was pulled + stored (no quota error). */
  sourcesPulled: number;
  /** Style-corpus rows upserted across all sources this run. */
  corpusRows: number;
  /** Ultra profiles (re)generated this run. */
  profilesWritten: number;
  /** Corpus rows dense-embedded this run (backfill + newly pulled). */
  embeddedRows: number;
  /**
   * Set when an Apify quota/concurrency wall (402/429/all-tokens-exhausted) was
   * hit. The entry surfaces this as an errored worker_runs row + bus event so the
   * operator sees the cost gate, rather than a silent partial run.
   */
  quotaError?: string;
}

export async function runAccountFeederTick(deps: FeederTickDeps): Promise<FeederTickResult> {
  const { log, instance, sources } = deps;
  const postLimit = deps.postLimit ?? DEFAULT_POST_LIMIT;
  const commentLimit = deps.commentLimit ?? DEFAULT_COMMENT_LIMIT;
  const concurrency = deps.concurrency ?? DEFAULT_CONCURRENCY;

  let corpusRows = 0;
  let sourcesPulled = 0;
  let quotaError: string | undefined;
  // Only accounts whose corpus landed cleanly get an extractor (no point
  // extracting from a source that errored mid-pull).
  const extractable: FeederSource[] = [];

  // ---- Phase 1: pull + store corpus (sequential; gentle on Apify) ----------
  for (const source of sources) {
    // A quota wall already hit — stop pulling further sources (they'd just hit
    // the same cap) and let the run surface the error.
    if (quotaError) break;
    try {
      const rows = await pullSourceCorpus(deps, source, { postLimit, commentLimit });
      corpusRows += await deps.upsertStylePosts(rows);
      await deps.markSourcePulled(source.id).catch((err) =>
        log.warn({ source: source.handle, err: (err as Error).message }, "markSourcePulled failed"),
      );
      sourcesPulled++;
      extractable.push(source);
    } catch (err) {
      if (isApifyQuotaError(err)) {
        // SURFACE — do not swallow. Stop this source + flag the run.
        quotaError = (err as Error).message;
        log.error(
          { instance: instance.id, source: source.handle, err: quotaError },
          "apify quota/concurrency wall during feeder run; surfacing to operator",
        );
        break;
      }
      // Non-quota per-source failure: fail-open, keep going with other sources.
      log.error(
