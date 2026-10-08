import { computePerfRollup } from "@noelle/runtime/account-feeder-db";
export { computePerfRollup } from "@noelle/runtime/account-feeder-db";
import { readSourceCount } from "@noelle/runtime/source-values";
import { z } from "zod";
import type { Logger } from "../lib/logger.js";
import type { ApifyLinkedInClient } from "@noelle/linkedin-apify";
import { ApifyError } from "@noelle/linkedin-apify";
import { batchMap, type SpendRecorder } from "@noelle/runtime";
import { withMeteredApifyCall } from "@noelle/runtime/apify-metering";
import type { EngineBackend } from "@noelle/runtime";
import { SYSTEM_STYLE_EXTRACTOR } from "../lib/prompts.js";
import type {
  FeederInstance,
  FeederSource,
  StylePostUpsert,
  StylePostEmbedding,
  CorpusItem,
  AccountUltraProfileUpsert,
} from "../lib/account-feeder-db.js";

// The Account Feeder's per-run orchestration. Mirrors runProfilerTick (poll →
// Apify pull → LLM extract → direct-SQL upsert) but for the STYLE corpus, not
// the per-person profile.
//
//   1. For each enabled source account:
//        a. profilePosts   → upsert account_style_posts kind='post'
//        b. authoredComments → upsert account_style_posts kind='comment'
//        (meter each Apify run; stamp last_pulled_at)
//   2. Fan out (batchMap) ONE Gemini style-extractor per source account →
//      upsert account_ultra_profiles (+ perf rollup from the columnar counts).
//
// CRITICAL INVARIANTS:
//   (i)  Source posts/comments go ONLY into account_style_posts — NEVER
//        noelle.leads. They are style exemplars, not reply targets. (This module
//        imports nothing that writes leads; the contract is structural.)
//   (ii) Apify 402 (usage cap) / 429 (concurrency) — and "all tokens exhausted"
//        — SURFACE to the operator: they stop that source and mark the whole run
//        errored (a bus event + an errored worker_runs row), NOT swallowed like
//        discovery/profiler. A cost-gated manual pull must tell the operator it
//        hit the wall.
//   (iii) Fail-open per unit: one source erroring (non-quota) doesn't abort the
//        run; one Gemini extraction failing doesn't lose the already-stored
//        corpus (corpus rows persist; only that account's ultra profile is skipped).

export const STYLE_EXTRACTOR_MODEL = "gemini-2-5-flash";

// One extraction distils a full style profile from ~60 posts — a large, slow
// generation. The Gemini-key backend's 8 s default aborts it every time
// ("This operation was aborted" → 0 profiles written). Give the extractor real
// headroom; it's a manual, low-frequency, one-call-per-source operation.
export const STYLE_EXTRACTOR_TIMEOUT_MS = 90_000;

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

/** The extractor's strict-JSON output (parsed with extractJson→Zod, fail-open). */
export const UltraProfileOutput = z.object({
  voice_summary: z.string().default(""),
  tone: z.string().default(""),
  structure_notes: z.string().default(""),
  hook_patterns: z.array(z.string()).max(20).default([]),
  signature_phrases: z.array(z.string()).max(20).default([]),
  top_topics: z.array(z.string()).max(20).default([]),
});
export type UltraProfileOutputT = z.infer<typeof UltraProfileOutput>;

/** Pull + corpus-write deps (the Apify client + the corpus upsert seam). */
export interface FeederTickDeps {
  log: Logger;
  instance: FeederInstance;
  sources: FeederSource[];
  /** Apify client — only the two read methods the feeder needs. */
  apify: Pick<ApifyLinkedInClient, "profilePosts" | "authoredComments" | "drainLastRunUsd" | "drainRunReceipts" | "isolateOperation">;
  /** Vertex Gemini backend — one call per source for style extraction. */
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
        { instance: instance.id, source: source.handle, err: (err as Error).message },
        "feeder source pull failed; skipping this source",
      );
    }
  }

  // ---- Phase 2: fan out Gemini style extractors (one per pulled source) -----
  let profilesWritten = 0;
  if (extractable.length > 0) {
    const outcomes = await batchMap(
      extractable,
      (source) => extractAndUpsert(deps, source),
      { concurrency },
    );
    for (let i = 0; i < outcomes.length; i++) {
      const outcome = outcomes[i]!;
      if (outcome.ok && outcome.value) {
        profilesWritten++;
      } else if (!outcome.ok) {
        // One extraction failing never loses the corpus — it's already stored.
        log.error(
          { instance: instance.id, source: extractable[i]?.handle, err: errMsg(outcome.error) },
          "style extraction failed for source; corpus retained, profile skipped",
        );
      }
    }
  }

