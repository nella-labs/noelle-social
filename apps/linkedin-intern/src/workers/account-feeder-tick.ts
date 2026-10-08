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

  // ---- Phase 3: dense-embed corpus rows (one-time backfill + newly pulled) ---
  // Voyage voyage-3-large → the pgvector `embedding` column the F4b hybrid ranker
  // fuses with the rerank. Fail-open at every step: any missing dep, no key, an
  // empty embed result, or an error leaves rows un-embedded (the ranker simply
  // skips the dense half) and never fails the run.
  let embeddedRows = 0;
  if (deps.embed && deps.listUnembeddedStylePosts && deps.updateStylePostEmbeddings) {
    try {
      const missing = await deps.listUnembeddedStylePosts(instance.id, EMBED_MAX_PER_TICK);
      for (let i = 0; i < missing.length; i += EMBED_CHUNK) {
        const chunk = missing.slice(i, i + EMBED_CHUNK);
        const vectors = await deps.embed(chunk.map((r) => r.body));
        // Fail-open: voyageEmbed returns [] on any failure / a partial result.
        if (vectors.length !== chunk.length) break;
        const updates = chunk.map((r, j) => ({ id: r.id, body: r.body, embedding: vectors[j]! }));
        embeddedRows += await deps.updateStylePostEmbeddings(updates);
      }
    } catch (err) {
      log.warn(
        { instance: instance.id, err: errMsg(err) },
        "style embedding pass failed; corpus retained un-embedded (dense ranker falls back to rerank)",
      );
    }
  }

  log.info(
    { instance: instance.id, sourcesPulled, corpusRows, profilesWritten, embeddedRows, quotaError: quotaError ?? null },
    "account feeder tick complete",
  );
  return { sourcesPulled, corpusRows, profilesWritten, embeddedRows, ...(quotaError ? { quotaError } : {}) };
}

/** Pull a single source's posts + authored comments and normalize to corpus rows. */
async function pullSourceCorpus(
  deps: FeederTickDeps,
  source: FeederSource,
  limits: { postLimit: number; commentLimit: number },
): Promise<StylePostUpsert[]> {
  const { instance, recorder, credentialId } = deps;
  const rows: StylePostUpsert[] = [];
  const metered = <T>(actor: string, call: (operation: typeof deps.apify) => Promise<T>) =>
    withMeteredApifyCall({ client: deps.apify, recorder, log: deps.log,
      orgId: instance.org_id, instanceId: instance.id, agentRole: "linkedin_intern",
      worker: "feeder", actor, startedAt: new Date(), credentialId: credentialId ?? null }, call);

  // a) POSTS
  const posts = await metered("linkedin-profile-posts", operation =>
    operation.profilePosts({ publicId: source.handle, maxPosts: limits.postLimit }));
  for (const p of posts) {
    if (!p.id || !p.text) continue;
    rows.push({
      orgId: instance.org_id,
      agentInstanceId: instance.id,
      platform: source.platform,
      accountHandle: source.handle,
      externalId: p.id,
      kind: "post",
      body: p.text,
      likeCount: readSourceCount(p.reactions),
      commentCount: readSourceCount(p.comments),
      raw: p,
      postedAt: p.postedAt || null,
    });
  }

  // b) AUTHORED COMMENTS (the account's real outbound reply voice)
  const comments = await metered("linkedin-profile-comments", operation => operation.authoredComments({
    publicId: source.handle, maxComments: limits.commentLimit,
  }));
  for (const c of comments) {
    if (!c.id || !c.text) continue;
    rows.push({
      orgId: instance.org_id,
      agentInstanceId: instance.id,
      platform: source.platform,
      accountHandle: source.handle,
      externalId: c.id,
      kind: "comment",
      body: c.text,
      likeCount: readSourceCount(c.reactions),
      commentCount: readSourceCount(c.repliesCount),
      raw: c,
      postedAt: c.createdAt || null,
    });
  }

  return rows;
}

/** Read one source's stored corpus, run the extractor, and upsert its profile. */
async function extractAndUpsert(deps: FeederTickDeps, source: FeederSource): Promise<boolean> {
  const { instance, log } = deps;
  const corpus = await deps.getCorpus({
    agentInstanceId: instance.id,
    platform: source.platform,
    accountHandle: source.handle,
    limit: DEFAULT_CORPUS_FOR_EXTRACT,
  });
  if (corpus.length === 0) {
    log.info({ source: source.handle }, "no stored corpus for source; skipping extraction");
    return false;
  }

  const res = await deps.extractor.call({
    system: SYSTEM_STYLE_EXTRACTOR,
    prompt: renderExtractorPrompt(source, corpus),
    model: STYLE_EXTRACTOR_MODEL,
  });

  const parsed = UltraProfileOutput.safeParse(extractJson(res.text));
  if (!parsed.success) {
    log.error(
      { source: source.handle, raw: res.text.slice(0, 200) },
      "style extractor output schema fail; skipping profile (corpus retained)",
    );
    return false;
  }

  const rollup = computePerfRollup(corpus);
  await deps.upsertUltraProfile({
    orgId: instance.org_id,
    agentInstanceId: instance.id,
    platform: source.platform,
    accountHandle: source.handle,
    voiceSummary: parsed.data.voice_summary,
    tone: parsed.data.tone,
    structureNotes: parsed.data.structure_notes,
    hookPatterns: parsed.data.hook_patterns.slice(0, 8),
    signaturePhrases: parsed.data.signature_phrases.slice(0, 8),
    topTopics: parsed.data.top_topics.slice(0, 8),
    avgLikeCount: rollup.avgLikeCount,
    avgCommentCount: rollup.avgCommentCount,
    postsAnalyzed: rollup.postsAnalyzed,
    samplePostIds: rollup.samplePostIds,
    model: STYLE_EXTRACTOR_MODEL,
  });
  return true;
}

function renderExtractorPrompt(source: FeederSource, corpus: CorpusItem[]): string {
  const who = source.displayName ?? source.handle;
  const posts = corpus.filter((c) => c.kind === "post");
  const comments = corpus.filter((c) => c.kind === "comment");
  const lines: string[] = [
    `Extract the writing STYLE of this LinkedIn account: ${who} (linkedin.com/in/${source.handle}).`,
    "",
    `POSTS they wrote (${posts.length}), with engagement:`,
    ...posts.map((p, i) => `[P${i + 1}] (${p.likeCount ?? "unknown"} reactions, ${p.commentCount ?? "unknown"} comments) ${oneLine(p.body)}`),
  ];
  if (comments.length > 0) {
    lines.push(
      "",
      `COMMENTS they wrote on others' posts (${comments.length}) — their real reply voice:`,
      ...comments.map((c, i) => `[C${i + 1}] (${c.likeCount ?? "unknown"} reactions) ${oneLine(c.body)}`),
    );
  }
  lines.push(
    "",
    "Output the strict JSON style object specified in the system prompt. Ground every field ONLY in the text above; do not invent. First char `{`, last char `}`.",
  );
  return lines.join("\n");
}

/**
 * Whether an error is an Apify quota/concurrency wall that must SURFACE (402 usage
 * cap, 429 too-many-runs) or an "all tokens exhausted" rotation failure. Matched
 * by ApifyError.status and by name (AllApifyTokensExhaustedError is thrown from
 * the rotating client and isn't importable here without a cycle, so match by
 * name) — both mean the operator hit their cost gate.
 */
export function isApifyQuotaError(err: unknown): boolean {
  if (err instanceof ApifyError && (err.status === 402 || err.status === 429 || err.status === 403)) {
    return true;
  }
  const name = (err as { name?: string } | null)?.name;
  return name === "AllApifyTokensExhaustedError";
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function oneLine(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/**
 * Parse the model's text into a JSON object. Vertex Gemini, called without a
 * forced JSON mime-type, sometimes wraps the object in a ```json fence or
 * surrounds it with prose, so strip fences and fall back to the first `{...}`
 * span before giving up. Returns null when nothing parses. (Same shape as the
 * x-intern classifier-engine extractJson.)
 */
function extractJson(text: string): unknown {
  const trimmed = text.trim();
  const unfenced = trimmed
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
  for (const candidate of [unfenced, sliceBraces(unfenced)]) {
