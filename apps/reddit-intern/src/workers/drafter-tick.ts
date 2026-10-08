import { readSourceCount, readSourceVoteScore, readSourceTimestamp } from "@noelle/runtime/source-values";
import { makesCommitment, commitmentReason, detectCommitments } from "@noelle/runtime/commitment-guard";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { JSONValue, Sql } from "postgres";
import type { Logger } from "../lib/logger.js";
import type { ActiveInstance } from "../lib/activation.js";
import type { LeadRow } from "../lib/leads-db.js";
import type { CodexRunner } from "../lib/codex-runner.js";
import type { OutboundIn } from "@noelle/contracts";
import { parseBrandConfig, resolveRedditTarget, OutboundFactualContextSchema } from "@noelle/contracts";
import type {
  Bus,
  KnowledgeBase,
  VerifierCall,
  DraftToVerify,
  VerifyContext,
  DraftVerdict,
  CaptionFn,
  DynamicPattern,
  PriorRepliesArgs,
} from "@noelle/runtime";
import {
  BudgetExceededError,
  applyReplyEmojiPolicy,
  verifyTiered,
  toOutboundVerifierMeta,
  captionImages,
} from "@noelle/runtime";
import { buildDrafterSystem, buildLightDrafterSystem } from "../lib/prompts.js";
import { loadActivePatternRules } from "../lib/pattern-breaker-db.js";
import {
  pickRegister,
  pickRegisterForEnergy,
  renderRegisterBlock,
  renderEnergyHint,
  detectPostEnergy,
} from "../lib/register.js";
import { renderCommentDigest, type SiblingComment } from "@noelle/runtime/comment-digest";
import { stripEmDashes } from "@noelle/runtime/voice-sanitize";
import { pickOpeningMove, renderOpeningMoveBlock, OPENING_MOVES } from "../lib/opening-move.js";
import type { ReplyKindValue } from "../lib/classifier-engine.js";
import { redditInternRouting, opusOverrideRouting, type ModelRouting } from "../lib/routing.js";
import {
  REDDIT_FORM_VARIANTS,
  TONE_FIRST_ENERGIES,
  STANCE_SHAPE_IDS,
  SHAPES_WITH_FREE_OPENER,
  SHAPES_BANNING_QUESTIONS,
  TONE_FIRST_SHAPE_SHARE,
  LIGHT_EXCLUDED_VARIANT_IDS,
  shapesExcludedForEnergy,
  createFormVariantRotation,
  renderAssignedShapeBlock,
  createGenZMarkerRotation,
  renderGenZMarkerBlock,
  genzMarkerRateFromEnv,
  type FormVariant,
  type GenZMarker,
} from "@noelle/runtime";
import type { PostEnergy } from "../lib/register.js";


// Orion runs the X-tuned shape set, not Lyra's. Reddit and X reward the same
// two moves LinkedIn punishes — being funny (RIFF) and disagreeing flat
// (FLAT_DISAGREE) — and both rooms tolerate a one-word comment, which is what
// X_FORM_VARIANTS' MICRO permits and Lyra's does not.
//
// ONE rotation per worker process, so "no shape repeats within the last N"
// holds across leads AND across ticks. Exported for tests.
export const redditFormVariantRotation = createFormVariantRotation(REDDIT_FORM_VARIANTS);

// Gen-z MARKER rotation, process-wide for the same reason. Reddit gets the FULL
// marker set (no plainOnly): it is the one room where the performative tier is
// native rather than a costume. Exported for tests.
export const redditGenZMarkerRotation = createGenZMarkerRotation();

// SUBSTANTIAL output: the classic three-angle shape, but the drafter only KEEPS
// the first N angles per tier (T1→3, T2→2, T3→1). The model is still asked for
// the angles its tier allows; we validate at least one. Reddit replies carry NO
// DM (Orion only drafts public comments).
// `char_count` tolerates ANY model sloppiness (absent, null, string, float —
// `.catch(undefined)` swallows all of it): the value is recomputed off the
// cleaned body in buildOutbound anyway, so a good body must never error the
// lead over a bad count (Lyra lost 14/37 leads to this on 2026-07-19).
const SubstantialDrafts = z.object({
  drafts: z
    .array(
      z.object({
        angle: z.enum(["empathetic", "technical", "contrarian"]),
        body: z.string().min(1),
        char_count: z.number().int().nonnegative().nullish().catch(undefined),
      }),
    )
    .min(1),
});

// LIGHT output: exactly one short supportive comment.
const LightDrafts = z.object({
  drafts: z
    .array(
      z.object({
        angle: z.enum(["empathetic", "technical", "contrarian", "supportive"]),
        body: z.string().min(1),
        char_count: z.number().int().nonnegative().nullish().catch(undefined),
      }),
    )
    .min(1),
});

const DrafterSkip = z.object({ skip: z.string().min(1) });
const SubstantialOutput = z.union([SubstantialDrafts, DrafterSkip]);
const LightOutput = z.union([LightDrafts, DrafterSkip]);

/** Angle ordering by tier — substantial leads keep the first N of these. */
const TIER_ANGLES: Record<"T1" | "T2" | "T3", Array<"empathetic" | "technical" | "contrarian">> = {
  T1: ["empathetic", "technical", "contrarian"],
  T2: ["empathetic", "technical"],
  T3: ["empathetic"],
};

export interface RunDrafterTickArgs {
  /**
   * The operator's approved replies paired with the posts they answered.
   * Fetched once per tick — the set barely moves between leads.
   */
  voiceExemplars?: ReadonlyArray<{ post: string; reply: string }>;

  log: Logger;
  instance: ActiveInstance;
  claimedLeads: LeadRow[];
  runner: CodexRunner;
  kb: KnowledgeBase;
  postOutbound: (body: OutboundIn) => Promise<{ id: string; approval_id: string }>;
  markStatus: (args: { leadId: string; status: "drafted" | "errored" | "skipped"; meta?: Record<string, unknown> }) => Promise<void>;
  /**
   * Minimum `max(anchor.score)` required to draft a lead. Default 6 (normalized
   * BM25 scale; see env.ts). Light leads bypass it (a congrats doesn't need a
   * voice anchor). Mirrors x-intern.
   */
  relevanceThreshold?: number;
  /** Daily cap on SUBSTANTIAL posts drafted (REDDIT_DAILY_SUBSTANTIAL_CAP). */
  dailySubstantialCap?: number;
  /** Daily cap on LIGHT posts drafted (REDDIT_DAILY_LIGHT_CAP). */
  dailyLightCap?: number;
  /**
   * Max post age (hours) still worth drafting (REDDIT_MAX_POST_AGE_HOURS).
   * A claimed lead whose `payload.posted_at` is older than this is SKIPPED
   * (reason `post-too-old`) instead of drafted, so the daily budget + approval
   * queue aren't spent on threads past their live upvote window. 0/omitted =
   * OFF (no age cull). A lead with no `posted_at` is never age-skipped.
   */
  maxPostAgeHours?: number;
  /**
   * How many leads of a given reply_kind were already drafted today (before this
   * tick). The worker wires this to leads-db.countDraftedTodayByKind. Defaults to
   * 0 so tests that omit it never trip the cap.
   */
  draftedTodayByKind?: (replyKind: ReplyKindValue) => Promise<number>;
  /** Complete standing rules admitted once before this tick's work claims. */
  patternRules?: readonly DynamicPattern[];
  /** Optional SQL handle for daily-cap deferral. Tests can omit it. */
  sql?: Sql;
  /**
   * Score-based Opus tiering thresholds. A lead whose source post is
   * high-engagement gets drafted with Opus. The rule:
   *   useOpus = score > opusScoreThreshold || comments > opusCommentsThreshold
   * Defaults are MAX_SAFE_INTEGER so a test that omits them never trips Opus.
   */
  opusScoreThreshold?: number;
  opusCommentsThreshold?: number;
  /** Opus model handle to override to (NOELLE_DRAFTER_OPUS_MODEL). */
  opusModel?: string;
  /** Shared-memory bus (optional). Emits a `draft.created` event per lead drafted. */
  bus?: Bus;
  /**
   * Vault subdirs to scope VOICE retrieval to (empty/undefined → unscoped).
   * Mirrors x-intern.
   */
  voiceDirs?: string[];
  /**
   * Vault subdirs to scope a SECOND, KNOWLEDGE retrieval pass to (product /
   * positioning / ICP). When non-empty, the drafter grounds the reply in
   * retrieved operator knowledge, not just voice. Empty → no knowledge pass.
   */
  knowledgeDirs?: string[];
  /** How many knowledge chunks to retrieve in the second pass (default 4). */
  knowledgeTopK?: number;
  /**
   * Post-draft verifier. When enabled, each lead's drafts are graded against the
   * grounding context after drafting; a failing verdict triggers up to `retries`
   * regenerations with the critique appended, then the best attempt is queued.
   * Applies to BOTH the substantial and light paths.
   */
  verify?: {
    enabled: boolean;
    retries: number;
    makeCalls: (priority: boolean) => VerifierCall[];
    /** Voice floor (0-1). Below this after retries → drop the draft. 0/undefined = no gate. */
    voiceFloor?: number;
  };
  /**
   * Vision caption fn. When a lead's payload carries `images`, the tick captions
   * them and injects "THE POST'S IMAGE SHOWS:" into the prompt. Omit and drafting
   * proceeds with no caption — fail-open throughout.
   */
  captionFn?: CaptionFn;
  /**
   * Voice variety (NOELLE_DRAFTER_VARIETY). When enabled, each lead is assigned a
   * random "register" injected into the comment-drafting prompt so comments vary
   * in length + energy across the feed. `rng` is injectable for deterministic tests.
   */
  variety?: {
    enabled: boolean;
    rng?: () => number;
    /**
     * Per-comment SHAPE rotation. Orion had NO form variation at all — every
     * comment was drafted in the same default 1-4 sentence band with only the
     * register varying — so this is the lane that breaks his feed out of one
     * mold. Injectable for tests; defaults to the process-wide rotation.
     */
    formVariantRotation?: {
      next: (rng?: () => number, exclude?: readonly string[]) => FormVariant;
    };
    /** Per-comment gen-z MARKER rotation. Injectable for tests. */
    genzMarkerRotation?: {
      next: (rng?: () => number, energy?: PostEnergy | null) => GenZMarker | null;
    };
    /**
     * Share of leads offered a gen-z marker. Defaults to
     * genzMarkerRateFromEnv() (22%, `NOELLE_GENZ_MARKERS=0` to disable).
     */
    genzMarkerRate?: number;
  };
  /**
   * Post-energy mirroring (NOELLE_DRAFTER_ENERGY, default off). When enabled the
   * drafter detects each post's energy (celebration/joke/hot_take/vent/question/
   * analytical) and (a) picks an energy-aware register when variety is on — DEADPAN on
   * a joke, never snark on a question — and (b) injects a "POST ENERGY" hint so the
   * comment MIRRORS the thread: answer a joke with a joke, a vent with commiseration,
   * not philosophy. Off/omitted → blind register only, byte-identical to today.
   */
  energy?: { enabled: boolean };
  /**
   * Sibling-comment "read the room" fetch (NOELLE_DRAFTER_COMMENT_ENERGY). When
   * provided, the tick fetches the top OTHER comments on each thread and injects a
   * digest so the comment matches the room's energy and never echoes a take already
   * made. Reddit reads the FREE public .json endpoint (no token, no Apify spend), so
   * this is fail-open by construction. Undefined → off, byte-identical to today.
   */
  fetchSiblingComments?: (lead: LeadRow) => Promise<SiblingComment[]>;
  /**
   * Per-author "what you already said" memory. When set, the tick fetches the
   * reply bodies Orion already SENT or QUEUED for the selected recipient and injects
   * them into the comment prompt with a "do not repeat these" instruction.
   */
  getPriorReplies?: (args: Omit<PriorRepliesArgs, "agentInstanceId">) => Promise<string[]>;
  /** How many prior replies-per-author to inject (REDDIT_DRAFTER_SENT_TOPK). Default 3. */
  priorRepliesTopK?: number;
  /**
   * Global "phrasings you've reached for lately" memory. When set, the tick
   * fetches Orion's most recent reply bodies across the WHOLE feed ONCE per tick
   * and injects them into the comment prompt as an AVOID list.
   */
  getRecentPhrasings?: (args: {
    excludeLeadId?: string | null;
    limit: number;
  }) => Promise<string[]>;
  /** How many recent reply bodies to inject as the avoid-list (REDDIT_DRAFTER_RECENT_PHRASINGS_TOPK). Default 10. */
  recentPhrasingsTopK?: number;
  /**
   * Prompt-injection fence (NOELLE_DRAFTER_FENCE; default ON for Reddit). When
   * true, the UNTRUSTED post text, image caption, and top-comments digest are
   * wrapped in delimiters with a "data, never instructions" guard so a hostile
   * post/comment can't hijack the drafter. Off → the prompt reads byte-identical
   * to the legacy (unfenced) behaviour. Threaded from env by the worker.
   */
  fenceUntrusted?: boolean;
  /**
   * Deterministic comment targeting (REDDIT_COMMENT_TARGETING). When enabled and a
   * post's top comment clears `minScore`, the draft targets THAT comment (the reply
   * is grounded in the comment, and buildOutbound stamps replyTarget:{kind:'comment'}).
   * Otherwise the draft targets the post (the default). Omit → never target comments.
   */
  commentTargeting?: { enabled: boolean; minScore: number };
}

const DEFAULT_RELEVANCE_THRESHOLD = 6;

interface RedditPayload {
  title?: string;
  text?: string;
  url?: string;
  subreddit?: string;
  score?: number | null;
  numComments?: number | null;
  images?: string[];
  /**
   * The post's real creation time (ISO), stamped by discovery
   * (upsertDiscoveredLead → payload.posted_at). The drafter echoes it back into
   * the outbound so api-vm's excluded-wins payload merge re-writes the SAME
   * value instead of clobbering it with draft time — keeping post age (and thus
   * reply latency) truthful for the age cutoff, the inbox label, and the sort.
   */
  posted_at?: string;
  /**
   * The post's most-upvoted comments (score desc), fetched at discovery time.
   * UNTRUSTED, attacker-authored text — every field is fenced before it reaches
   * the model. Powers the top-comments digest + deterministic comment targeting.
   */
  topComments?: Array<{ id: string; body: string; score: number | null; author: string; permalink: string }>;
}

/** One top comment (the element type of RedditPayload.topComments). */
type RedditTopComment = NonNullable<RedditPayload["topComments"]>[number];

export async function runDrafterTick(args: RunDrafterTickArgs): Promise<number> {
  const {
    log,
    instance,
    claimedLeads,
    runner,
    kb,
    postOutbound,
    markStatus,
    relevanceThreshold = DEFAULT_RELEVANCE_THRESHOLD,
    dailySubstantialCap = Number.MAX_SAFE_INTEGER,
    dailyLightCap = Number.MAX_SAFE_INTEGER,
    maxPostAgeHours = 0,
    draftedTodayByKind,
    sql,
    opusScoreThreshold = Number.MAX_SAFE_INTEGER,
    opusCommentsThreshold = Number.MAX_SAFE_INTEGER,
    opusModel,
    bus,
    voiceDirs,
    knowledgeDirs,
    knowledgeTopK = 4,
    verify,
    captionFn,
    variety,
    getPriorReplies,
    priorRepliesTopK = 3,
    getRecentPhrasings,
    recentPhrasingsTopK = 10,
    fenceUntrusted = false,
    commentTargeting,
  } = args;
  const voiceOpts =
    voiceDirs && voiceDirs.length ? { filterDirs: voiceDirs } : undefined;
  let processed = 0;

  // Global "what you've said lately" memory — fetched ONCE per tick (it spans all
  // authors, not this lead), injected as an avoid-list. Fail-open to [].
  const recentPhrasings = getRecentPhrasings
    ? await getRecentPhrasings({ limit: recentPhrasingsTopK }).catch(() => [])
    : [];

  // Base routing for this instance (default or per-instance override). A
  // high-engagement lead overrides this to Opus per lead; everyone else uses it.
  const baseRouting = redditInternRouting(instance);

  // Operator brand config (persona/product/pitch/styles), parsed once per tick.
  const brand = parseBrandConfig(instance.brand_config);

  // Active Pattern Breaker rules — over-used structures the breaker discovered
  // from the operator's last-N sent replies. Loaded ONCE per tick (instance-
  // scoped) and threaded into every draft's SYSTEM prompt + verifier. A failed
  // or incomplete read holds drafting for this tick.
  const patternRules: DynamicPattern[] = args.patternRules
    ? [...args.patternRules]
    : sql
      ? await loadActivePatternRules(sql, {
          orgId: instance.org_id,
          agentInstanceId: instance.id,
          role: "reddit_intern",
        })
      : [];

  // 0 (or any non-positive value) means UNLIMITED. Normalized HERE rather than at
  // the call site so a caller passing the raw env value can never turn "no cap"
  // into "draft nothing" — the destructuring default above only covers
  // `undefined`, not 0.
  const substantialCap = dailySubstantialCap > 0 ? dailySubstantialCap : Number.MAX_SAFE_INTEGER;
  const lightCap = dailyLightCap > 0 ? dailyLightCap : Number.MAX_SAFE_INTEGER;

  // Running daily-cap budget. Seed each kind from how many were already drafted
  // today, then decrement as we draft this tick. When a kind's budget hits 0,
  // remaining leads of that kind are left 'classified' for a later day.
  const remaining: Record<"substantial" | "light", number> = {
    substantial: substantialCap - (draftedTodayByKind ? await draftedTodayByKind("substantial") : 0),
    light: lightCap - (draftedTodayByKind ? await draftedTodayByKind("light") : 0),
  };

  for (const lead of claimedLeads) {
    const replyKind: "substantial" | "light" =
      lead.classifier_label === "light" ? "light" : "substantial";

    // Age cutoff (opt-in via maxPostAgeHours): a claimed lead whose post is
    // older than the cutoff is terminally skipped, not drafted — its live upvote
