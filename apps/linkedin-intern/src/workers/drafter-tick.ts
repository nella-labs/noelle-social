import { readSourceTimestamp } from "@noelle/runtime/source-values";
import { readReplyRequest, type ReplyRequestMeta } from "@noelle/runtime";
import { triageNotification, renderPin } from "@noelle/runtime/notification-triage";
import { renderConversationBlock, type ConversationBrief } from "@noelle/runtime";
import { makesCommitment, commitmentReason, detectCommitments } from "@noelle/runtime/commitment-guard";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { JSONValue, Sql } from "postgres";
import type { Logger } from "../lib/logger.js";
import type { ActiveInstance } from "../lib/activation.js";
import { hasCanonicalObservedIdentity, type LeadRow } from "../lib/leads-db.js";
import type { CodexRunner } from "../lib/codex-runner.js";
import type { OutboundIn } from "@noelle/contracts";
import { parseBrandConfig, OutboundFactualContextSchema } from "@noelle/contracts";
import type {
  Bus,
  KnowledgeBase,
  VerifierCall,
  DraftToVerify,
  VerifyContext,
  DraftVerdict,
  CaptionFn,
  DynamicPattern,
} from "@noelle/runtime";
import {
  BudgetExceededError,
  stripDisallowedEmoji,
  applyReplyEmojiPolicy,
  verifyTiered,
  toOutboundVerifierMeta,
  refineDmVoice,
  captionImages,
} from "@noelle/runtime";
import type { LinkedInComment } from "@noelle/linkedin-apify";
import {
  buildDrafterSystem,
  drafterSystemCachePrefixLen,
  buildLightDrafterSystem,
  renderCommentDigest,
  renderStyleBlock,
  SYSTEM_LINKEDIN_INTRO,
  renderIntroDmPrompt,
  buildLadderDmSystem,
  renderLadderDmPrompt,
  BATCHED_LIGHT_SYSTEM_SUFFIX,
  renderBatchedLightUserPrompt,
  type StyleForPrompt,
  type BatchedLightLeadInput,
} from "../lib/prompts.js";
import { pickRung } from "../lib/dm-ladder.js";
import { countSentDmsToAuthor, getRecentDmsToAuthor } from "../lib/dm-ladder-db.js";
import {
  selectStyleExemplars,
  buildStyleSource,
  pickFaithfulVoice,
  createFormVariantRotation,
  renderAssignedShapeBlock,
  LIGHT_EXCLUDED_VARIANT_IDS,
  TONE_FIRST_SHAPE_SHARE,
  STANCE_SHAPE_IDS,
  shapesExcludedForEnergy,
  createGenZMarkerRotation,
  renderGenZMarkerBlock,
  genzMarkerRateFromEnv,
  type FormVariant,
  type GenZMarker,
} from "@noelle/runtime";
// buildStyleSource impl now lives in @noelle/runtime; re-exported for drafter-tick.test.ts.
export { buildStyleSource };

// Form-variant rotation: ONE rotation per worker process, so
// "no shape repeats within the last N" holds across leads AND across ticks.
// See @noelle/runtime formVariants.ts. Exported for tests.
export const formVariantRotation = createFormVariantRotation();

// Gen-z MARKER rotation, process-wide for the same reason: the lane exists so
// the feed does not repeat a marker, and only a long-lived instance has the
// memory to enforce that. See @noelle/runtime genzMarkers.ts.
//
// plainOnly is a LinkedIn policy, not a per-post one. Lyra gets the plain tier
// and never the performative one ("deadass", "cooked", "not me …ing"): on a
// professional network those cost more than they buy. The platform opt-in also
// gives Lyra the guarded conversational moves. Exported for tests.
export const genzMarkerRotation = createGenZMarkerRotation(4, {
  plainOnly: true,
  platform: "linkedin",
});

/**
 * Decide this lead's gen-z marker block. Shared by the light and substantial
 * paths so the two cannot drift — they already carry near-identical variety
 * assembly, and that is exactly where a divergence would go unnoticed.
 *
 * Returns undefined on the majority of leads (the rate gate), which leaves the
 * prompt byte-identical to before the lane existed.
 */
function pickGenzBlock(
  variety: RunDrafterTickArgs["variety"],
  postRegister: PostRegister,
): string | undefined {
  if (!variety?.enabled) return undefined;
  const rate = variety.genzMarkerRate ?? genzMarkerRateFromEnv();
  if (!(rate > 0)) return undefined;
  if ((variety.rng ?? Math.random)() >= rate) return undefined;
  // Lyra has no rich PostEnergy, only celebration/neutral. plainOnly already
  // pins the tier, so the energy is only carried through for the day the
  // richer signal reaches this worker.
  const energy = postRegister === "celebration" ? "celebration" : null;
  const marker = (variety.genzMarkerRotation ?? genzMarkerRotation).next(variety.rng, energy);
  return marker ? renderGenZMarkerBlock(marker) : undefined;
}
import { retrieveAnchors } from "../lib/grounding.js";
import { loadActivePatternRules } from "../lib/pattern-breaker-db.js";
import type { StyleExemplarRow, UltraProfileRow } from "../lib/account-feeder-db.js";
import {
  pickRegisterForPost,
  renderRegisterBlock,
  detectPostRegister,
  type PostRegister,
} from "../lib/register.js";
import { pickOpeningMove, renderOpeningMoveBlock } from "../lib/opening-move.js";
import { stripEmDashes } from "@noelle/runtime/voice-sanitize";
import { privateReviewTraceEnabled, writePrivateReviewTrace, type PrivateReviewAttempt } from "../lib/private-review-trace.js";
import type { ReplyKindValue } from "../lib/classifier-engine.js";
import {
  getWatchlistObjectives,
  getWatchlistProfiles,
  type IntroDmPerson,
  type WatchlistObjectiveEntry,
  type WatchlistProfileRow,
} from "../lib/watchlist-db.js";
import { linkedinInternRouting, opusOverrideRouting, type ModelRouting } from "../lib/routing.js";

type VerifierCallFactory = (
  priority: boolean,
  options?: { directRouting?: boolean },
) => VerifierCall[];

// SUBSTANTIAL output: the classic three-angle shape, but the drafter only KEEPS
// the first N angles per tier (T1→3, T2→2, T3→1). The model is still asked for
// the angles its tier allows; we validate at least one.
// `char_count` tolerates ANY model sloppiness — absent, null, string, float
// (`.catch(undefined)` swallows all of it). The model routinely omits it or
// emits it at the wrong level, and buildOutbound recomputes the real length off
// the cleaned body anyway — a good body must never be errored over a bad count
// (2026-07-19: 14/37 leads lost to exactly this).
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
  // DM is only requested for T1; optional so a tier that drops it still parses.
  dm: z
    .object({
      body: z.string().min(1),
      char_count: z.number().int().nonnegative().nullish().catch(undefined),
    })
    .optional(),
});

// LIGHT output: exactly one short supportive comment, no DM.
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

// Single-DM output: one relationship-building DM body. No drafts array, no
// angle, no skip — just the one DM. Used by BOTH the intro-DM path and the DM
// ladder (runDmRequestTick). `char_count` tolerates anything because both paths
// IGNORE the model's value and recompute the real length off the scrubbed body — so a
// DM whose body is perfectly fine must not be dropped just because the model
// omitted the count (a common LLM omission), which on the ladder path would
// silently lose the DM (the dm_requested flag is already cleared on claim).
const IntroDmOutput = z.object({
  body: z.string().min(1),
  char_count: z.number().int().nonnegative().nullish().catch(undefined),
});

const DrafterSkip = z.object({ skip: z.string().min(1) });
const SubstantialOutput = z.union([SubstantialDrafts, DrafterSkip]);
const LightOutput = z.union([LightDrafts, DrafterSkip]);

// BATCHED LIGHT output: a JSON array where each entry carries back the lead's
// batch id + the one short reply. Zod validates length (must equal batch size)
// and id presence — callers additionally verify ids match the batch exactly.
const BatchedLightEntry = z.object({
  id: z.string().min(1),
  reply: z.string().min(1),
});
const BatchedLightOutput = z.array(BatchedLightEntry).min(1);

/** Angle ordering by tier — substantial leads keep the first N of these. */
const TIER_ANGLES: Record<"T1" | "T2" | "T3", Array<"empathetic" | "technical" | "contrarian">> = {
  T1: ["empathetic", "technical", "contrarian"],
  T2: ["empathetic", "technical"],
  T3: ["empathetic"],
};

// Browser replies use only curated voice folders. Empty filterDirs means an
// unscoped whole-vault search in both KB backends, so never pass [] for them.
const BROWSER_VOICE_DIRS = new Set(["noelle-voice", "content/voice-anchors"]);
// These shapes impose facts or a repeated formatting habit that the browser
// post alone cannot support. Bare questions also prompted unsupported metric
// requests in the unattended lane. Legacy leads retain the full rotation.
const BROWSER_OBSERVED_EXCLUDED_VARIANT_IDS = ["SELF_STORY", "AGREE_EXTEND", "MICRO", "QUESTION_ONLY"];

/** Judge short browser comments against comments the operator actually sent. */
function voiceReferencesForReply(args: {
  anchors: Array<{ snippet: string }>;
  style: StyleForPrompt | null | undefined;
  browserReply: boolean;
  faithful: boolean | undefined;
  sentReplies?: ReadonlyArray<{ reply: string }>;
}): { writerAnchors: string[]; reviewAnchors: string[] } {
  const curated = args.anchors.map((anchor) => anchor.snippet);
  if (!args.browserReply) {
    return { writerAnchors: curated, reviewAnchors: curated };
  }
  const sent = [...new Set((args.sentReplies ?? []).map(({ reply }) => reply.trim()).filter(Boolean))]
    .slice(0, 4)
    .map((reply) => `Operator's already-sent LinkedIn reply (voice and form only; never factual support): ${reply.slice(0, 320)}`);
  if (!args.faithful) {
    return { writerAnchors: curated, reviewAnchors: sent.length ? sent : curated };
  }
  const selected = (args.style?.exemplars ?? [])
    .map((exemplar) => exemplar.body.trim())
    .filter(Boolean)
    .slice(0, 3)
    .map((body) => body.slice(0, 320));
  if (!selected.length) return { writerAnchors: curated, reviewAnchors: sent.length ? sent : curated };
  // The writer keeps the pinned STYLE block. For the short-comment judge, the
  // operator's sent replies are the closer voice match; pinned posts remain a
  // fallback when there are no sent replies. Neither supplies post facts.
  return {
    writerAnchors: [],
    reviewAnchors: sent.length ? sent : selected.map((body) =>
      `Pinned writer example (FORM and voice only; never use its claims or topic as facts): ${body}`),
  };
}

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
  /** Daily cap on SUBSTANTIAL posts drafted (LINKEDIN_DAILY_SUBSTANTIAL_CAP). */
  dailySubstantialCap?: number;
  /** Daily cap on LIGHT posts drafted (LINKEDIN_DAILY_LIGHT_CAP). */
  dailyLightCap?: number;
  /**
   * How many leads of a given reply_kind were already drafted today (before this
   * tick). The worker wires this to leads-db.countDraftedTodayByKind. Defaults to
   * 0 so tests that omit it never trip the cap.
   */
  draftedTodayByKind?: (replyKind: ReplyKindValue) => Promise<number>;
  /** Complete standing rules admitted once before this tick's work claims. */
  patternRules?: readonly DynamicPattern[];
  /**
   * Optional SQL handle for per-person profile + objective lookups. Tests can
   * omit it; the lookups no-op when absent (empty maps).
   */
  sql?: Sql;
  /**
   * Reaction-based Opus tiering thresholds. A lead whose source post is
   * high-engagement gets drafted with Opus (a great comment on a high-eyeball
   * post earns reciprocal engagement). The rule:
   *   useOpus = likes > opusLikesThreshold
   *          || (comments > opusCommentsThreshold && !comment_bait)
   * Defaults are MAX_SAFE_INTEGER so a test that omits them never trips Opus.
   */
  opusLikesThreshold?: number;
  opusCommentsThreshold?: number;
  /** Opus model handle to override to (NOELLE_DRAFTER_OPUS_MODEL). */
  opusModel?: string;
  /**
   * Fetch the existing comments on a post (via the Apify post-comments actor) so
   * the drafter can read the room and avoid echoing the crowd. Omit (tests, or
   * comment-energy disabled) and the drafter drafts with no comment context. The
   * caller meters each paid attempt; the tick builds the digest.
   */
  fetchPostComments?: (postUrl: string) => Promise<LinkedInComment[]>;
  /** Max comments to fetch per lead (cost bound). Default 40. */
  commentFetchMax?: number;
  /**
   * Only fetch comments when the post's known comment count is at least this
   * (a post with 0-1 comments has no "energy" worth paying to read). Default 2.
   */
  commentFetchMinCount?: number;
  /** Shared-memory bus (optional). Emits a `draft.created` event per lead drafted. */
  bus?: Bus;
  /**
   * Push the operator directly about a notification too important to answer
   * with an agent. Injected so the tick stays unit-testable; omitted ⇒ pins are
   * logged and skipped rather than pushed.
   */
  pinNotification?: (args: { title: string; message: string; url?: string }) => Promise<boolean>;
  /**
   * Vault subdirs to scope VOICE retrieval to (empty/undefined → unscoped,
   * exactly as today). Mirrors x-intern. See docs/grounded-drafting.md.
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
   * Voyage-rerank the BM25 grounding anchors (voice + knowledge) down to the
   * most semantically relevant topK. Off (default) ⇒ plain BM25 kb.search,
   * byte-identical to today. Read from NOELLE_DRAFTER_GROUNDING_RERANK.
   */
  rerankGrounding?: boolean;
  /**
   * Post-draft verifier. When enabled, each lead's drafts are graded against the
   * grounding context after drafting; a failing verdict triggers up to `retries`
   * regenerations with the critique appended, then the best attempt is queued
   * (with the verdict attached). `makeCalls(priority)` returns the judge call(s):
   * one cheap judge by default, N adversarial judges for high-value (watchlist /
   * priority) leads. Injected so the worker owns the model/routing/budget and the
   * tick stays unit-testable. Applies to BOTH the substantial and light paths.
   */
  verify?: {
    enabled: boolean;
    retries: number;
    makeCalls: VerifierCallFactory;
    /**
     * Voice floor (0-1). When the verifier ran and the best attempt's voice
     * score is BELOW this after all retries, that reply angle is DROPPED. The
     * lead is skipped with skip_reason='low-voice' only when no reply survives.
     * 0/undefined = no gate (serve the best attempt with its verdict attached).
     */
    voiceFloor?: number;
  };
  /**
   * Vision caption fn (B2b). When a lead's payload carries `images`, the tick
   * captions them and injects "THE POST'S IMAGE SHOWS:" into the prompt so the
   * drafter can react to the visual. Omit (no key, vision disabled) and drafting
   * proceeds with no caption — fail-open throughout.
   */
  captionFn?: CaptionFn;
  /**
   * Voice variety (NOELLE_DRAFTER_VARIETY). When enabled, each lead is assigned a
   * random "register" (ultra-short / hype / slang / punchy / normal) injected into
   * the COMMENT-drafting prompt (both the substantial and light paths) so comments
   * vary in length + energy across the feed. `rng` is injectable for deterministic
   * tests (defaults to Math.random in the worker). When disabled / omitted, no
   * register is injected and drafts are byte-identical to today. Only the comment
   * drafts get a register — the DM / intro-DM / DM-request paths are untouched.
   *
   * FAITHFUL leads (a pinned voice) instead get a FORM VARIANT: one of 10 shape
   * recipes (micro one-liner → question-only → run-on → a fuller 2-3 beat take)
   * picked per reply with the PREVIOUS reply's shape excluded, rendered inside
   * the faithful STYLE block. For those leads the register + opening-move blocks
   * are suppressed so the prompt carries ONE shape instruction, not three
   * contradicting ones. `formVariantRotation` is injectable for tests; the
   * worker default is a process-wide rotation (state survives across ticks).
   */
  variety?: {
    enabled: boolean;
    rng?: () => number;
    formVariantRotation?: {
      next: (rng?: () => number, exclude?: readonly string[]) => FormVariant;
    };
    /**
     * Per-reply gen-z MARKER rotation, injectable for deterministic tests.
     * Defaults to the process-wide rotation so the no-repeat memory survives
     * across ticks. See @noelle/runtime genzMarkers.ts.
     */
    genzMarkerRotation?: {
      next: (rng?: () => number, energy?: string | null) => GenZMarker | null;
    };
    /**
     * Share of leads offered a gen-z marker. Defaults to
     * genzMarkerRateFromEnv() (22%, `NOELLE_GENZ_MARKERS=0` to disable). The
     * RATE is the design: overdoing the slang reads as more machine-written,
     * not less.
     */
    genzMarkerRate?: number;
  };
  /**
   * Per-person "what you already said" memory. When set, the tick fetches the
   * reply bodies Lyra already SENT or QUEUED for THIS post's author and injects
   * them into the comment prompt with a "do not repeat these" instruction, so the
   * drafter stops re-saying the same take every time a connection posts. The
   * worker wires this to prior-replies-db.getRecentRepliesToAuthor; omit it
   * (tests, or topK 0) and drafting proceeds with no prior-reply context.
   * Applies to the substantial + light comment paths only (DMs are untouched).
   */
  getPriorReplies?: (args: {
    authorHandle: string | null;
    authorId?: string | null;
    excludeLeadId?: string | null;
    limit: number;
  }) => Promise<string[]>;
  /** How many prior replies-per-person to inject (LINKEDIN_DRAFTER_SENT_TOPK). Default 3. */
  priorRepliesTopK?: number;
  /**
   * Global "phrasings you've reached for lately" memory. When set, the tick
   * fetches Lyra's most recent reply bodies across the WHOLE feed (all authors)
   * ONCE per tick and (a) injects them into the comment prompt as an AVOID list
   * and (b) passes them to the verifier as `recentReplies` so a draft too alike a
   * recent one regenerates — the openers, shapes, and phrasings vary feed-wide,
   * not just per person. The worker wires this to
   * prior-replies-db.getRecentReplyPhrasings; omit it (tests, or topK 0) and
   * drafting proceeds with no global phrasing context.
   */
  getRecentPhrasings?: (args: {
    excludeLeadId?: string | null;
    limit: number;
  }) => Promise<string[]>;
  /** How many recent reply bodies to use for the avoid-list + diversity check (LINKEDIN_DRAFTER_RECENT_PHRASINGS_TOPK). Default 20. */
  recentPhrasingsTopK?: number;
  /**
   * Tiered multi-lead batching for LIGHT leads (F6b, default OFF — gated on
   * NOELLE_DRAFTER_BATCH via `batch.enabled`). When enabled AND the instance's
   * account_feeder_config.batchLightLeads is true (default), light leads that are
   * NOT Opus-eligible (and not subject to the verifier) are grouped into a SINGLE
   * batched drafter call per tick, cutting LLM cost for the cheap lane. Each lead
   * carries its OWN post text, OWN per-lead STYLE block, OWN anchors/knowledge.
   * The model returns a JSON array; Zod validates it; on ANY parse failure /
   * count mismatch / id mismatch / model error → fall back to per-lead single
   * calls for that group (today's behaviour). No lead is ever dropped or
   * cross-wired. High-value (Opus-eligible, watchlist-priority) leads always use
   * single calls. When batch.enabled is false (default) behaviour is
   * byte-identical to today (one-lead-one-call). Injected for testability.
   */
  batch?: {
    /** Master on/off (NOELLE_DRAFTER_BATCH). Default OFF. */
    enabled: boolean;
    /**
     * Whether the instance's account_feeder_config permits batch light leads.
     * Mirrors AccountFeederConfig.batchLightLeads (default true). Only used
     * when batch.enabled is true.
     */
    batchLightLeads?: boolean;
  };
  /**
   * Account Feeder STYLE injection (F6, default OFF — gated on NOELLE_DRAFTER_STYLE
   * via `style.enabled`). When enabled, the tick loads the style-exemplar
   * candidate pool + ultra profiles ONCE (via the injected loaders) and, per
   * lead, samples a few high-performing human exemplars (performance-weighted ×
   * fit, controlled variety; see lib/style-select.ts) into the drafter SYSTEM
   * prompt so comments imitate the FORM of real writers. Fail-open throughout:
   * a loader error, an empty pool, or any selection error ⇒ no STYLE block, the
   * lead drafts exactly as today. Applies to the substantial + light COMMENT
   * paths only (the DM / intro-DM / DM-request paths are untouched). Injected so
   * the worker owns the DB reads + flags and the tick stays unit-testable.
   */
  style?: {
    enabled: boolean;
    /** Load the candidate pool (kind='comment') once per tick. */
    loadPool: () => Promise<StyleExemplarRow[]>;
    /** Load the instance's ultra profiles once per tick (style notes source). */
    loadUltraProfiles: () => Promise<UltraProfileRow[]>;
    /** The instance's account_feeder_config jsonb (selection knobs). */
    config?: unknown;
    /** Use the F4b dense/hybrid ranker (NOELLE_DRAFTER_DENSE). Default false. */
    dense?: boolean;
    /** Injectable PRNG for deterministic variety in tests. */
    rng?: () => number;
    /**
     * When true (operator pinned a voice), write faithfully in that voice: no
     * register de-hype, adopt-the-voice STYLE block.
     */
    faithful?: boolean;
    /**
     * The faithful-voice handle list (from readFaithfulVoices). When it holds MORE
     * than one voice, the tick picks ONE per lead deterministically (rotating
     * across the feed) and restricts that lead's exemplar pool to it, so each reply
     * sounds like a single real writer. A single voice needs no per-lead filter.
     */
    faithfulVoices?: string[];
    /**
     * Optional per-voice weights parallel to faithfulVoices (from
     * readFaithfulVoiceWeights). When present, the per-lead voice draw is biased
     * by these proportions (e.g. 60/40) instead of uniform. undefined ⇒ uniform.
     */
    faithfulVoiceWeights?: number[];
  };
}

const DEFAULT_RELEVANCE_THRESHOLD = 6;

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
    draftedTodayByKind,
    sql,
    opusLikesThreshold = Number.MAX_SAFE_INTEGER,
    opusCommentsThreshold = Number.MAX_SAFE_INTEGER,
    opusModel,
    fetchPostComments,
    commentFetchMax = 40,
    commentFetchMinCount = 2,
    bus,
    voiceDirs,
    knowledgeDirs,
    knowledgeTopK = 4,
    rerankGrounding = false,
    verify,
    captionFn,
    variety,
    getPriorReplies,
    priorRepliesTopK = 3,
    getRecentPhrasings,
    recentPhrasingsTopK = 20,
    style,
    batch,
  } = args;
  let processed = 0;
  const browserVoiceDirs = (voiceDirs ?? []).filter((dir) => BROWSER_VOICE_DIRS.has(dir));

  // Faithful-voice mode: the operator PINNED a style source. When set, the tick
  // (a) skips the register-based cheer penalty in exemplar selection (so the
  // pinned voice's characteristic/high-performing posts are picked, not their
  // blandest) and (b) renders the adopt-the-voice STYLE block. Off (default) ⇒
  // the legacy blend path, byte-identical to before.
  const styleFaithful = style?.faithful === true;
  // The pinned voice list. When it holds >1 voice, each lead gets ONE of them
  // (rotating across the feed) so a single reply is faithfully one writer. Empty
  // or single-element ⇒ no per-lead voice filter (the whole faithful pool is used).
  const faithfulVoices = style?.faithfulVoices ?? [];
  const faithfulVoiceWeights = style?.faithfulVoiceWeights;

  // Global "what you've said lately" memory — fetched ONCE per tick (it spans all
  // authors, not this lead), injected as an avoid-list so openers/phrasings vary
  // across the whole feed. Fail-open to [].
  const recentPhrasings = getRecentPhrasings
    ? await getRecentPhrasings({ limit: recentPhrasingsTopK }).catch(() => [])
    : [];

  // Account Feeder STYLE pool + ultra profiles — loaded ONCE per tick (they're
  // instance-scoped, not per-lead) and reused across every claimed lead (spec §8
  // "retrieve once per tick"). Skipped entirely when style is off; fail-open to
  // empty arrays so a loader error just disables the STYLE block for this tick.
  const styleCandidates: StyleExemplarRow[] = style?.enabled
    ? await style.loadPool().catch((err) => {
        log.warn({ err: (err as Error).message }, "style pool load failed; drafting without style");
        return [];
      })
    : [];
  const styleProfiles: UltraProfileRow[] =
    style?.enabled && styleCandidates.length
      ? await style.loadUltraProfiles().catch((err) => {
          log.warn({ err: (err as Error).message }, "ultra-profile load failed; style notes omitted");
          return [];
        })
      : [];

  // Base routing for this instance (default or per-instance override). A
  // high-engagement lead overrides this to Opus per lead; everyone else uses it.
  const baseRouting = linkedinInternRouting(instance);
  // Derive final browser-repair routing from the ordinary instance writer, not
  // a high-engagement route that may already have Opus as its primary.
  const opusRepairRouting = opusOverrideRouting(baseRouting, opusModel);

  // Operator brand config (persona/product/pitch/styles), parsed once per tick.
  const brand = parseBrandConfig(instance.brand_config);

  // Per-watchlist-person profiles + objectives, fetched once per tick.
  const profilesByFsd: Map<string, WatchlistProfileRow> = sql
    ? await getWatchlistProfiles(sql, instance.id)
    : new Map();
  const objectivesByPublicId: Map<string, WatchlistObjectiveEntry> = sql
    ? await getWatchlistObjectives(sql, instance.id)
    : new Map();

  // Active Pattern Breaker rules — over-used structures the breaker discovered
  // from the operator's last-N posts. Loaded ONCE per tick (instance-scoped) and
  // threaded into every draft's SYSTEM prompt + verifier. A failed or incomplete
  // read holds drafting for this tick.
  const patternRules: DynamicPattern[] = args.patternRules
    ? [...args.patternRules]
    : sql
      ? await loadActivePatternRules(sql, {
          orgId: instance.org_id,
          agentInstanceId: instance.id,
          role: "linkedin_intern",
        })
      : [];

  // 0 (or any non-positive value) means UNLIMITED, matching how discovery reads
  // LINKEDIN_DAILY_EXTRACT_CAP. Normalized HERE rather than at the call site so a
  // caller passing the raw env value can never turn "no cap" into "draft nothing"
  // — the destructuring default above only covers `undefined`, not 0.
  const substantialCap = dailySubstantialCap > 0 ? dailySubstantialCap : Number.MAX_SAFE_INTEGER;
  const lightCap = dailyLightCap > 0 ? dailyLightCap : Number.MAX_SAFE_INTEGER;

  // Running daily-cap budget. Seed each kind from how many were already drafted
  // today, then decrement as we draft this tick. When a kind's budget hits 0,
  // remaining leads of that kind are left 'classified' for a later day.
  const remaining: Record<"substantial" | "light", number> = {
    substantial: substantialCap - (draftedTodayByKind ? await draftedTodayByKind("substantial") : 0),
    light: lightCap - (draftedTodayByKind ? await draftedTodayByKind("light") : 0),
  };

  // Whether tiered batching is enabled for this tick (env flag on + instance permits).
  // Default OFF → byte-identical to today.
  const batchingEnabled =
    batch?.enabled === true && (batch.batchLightLeads ?? true);

  // Pre-compute phase budget shadow: tracks how many slots remain for each kind
  // AS we categorize leads in the pre-compute loop. Starts equal to `remaining`
  // and is decremented when a lead is accepted (enqueued into batchableLights or
  // singleLeads). The `remaining` object itself is decremented only on actual
  // successful drafts (in the batch path + singles loop) so the two stay in sync
  // and cap semantics match the original sequential loop exactly.
  // Leads left 'classified' this tick because their kind's daily cap is spent.
  // Collected here and logged ONCE after the pre-compute loop (see the cap gate).
  const capDeferred: Record<"substantial" | "light", string[]> = { substantial: [], light: [] };

  // Set once the org's spend cap trips. The cap is ORG-WIDE, so every remaining
  // lead this tick would hit the same wall — and the pre-draft gathering that
  // runs BEFORE the model call is not free (captionImages = a vision call,
  // fetchCommentDigest = a metered Apify fetch, and Apify does NOT count toward
  // the LLM cap). Budget-deferred leads are retried on the next tick, so without
  // this flag a blown budget would re-pay that gathering for every lead, every
  // ~30s. With it, at most ONE lead's gathering is spent per tick.
  let budgetBlown = false;

  const budgetLeft: Record<"substantial" | "light", number> = {
    substantial: remaining.substantial,
    light: remaining.light,
  };

  // ── Categorize leads before paid gathering ────────────────────────────────
  // Saved engagement and review/request gates decide batch eligibility. Single
  // LIGHT contexts are gathered only after their turn's spend-budget gate.

  /** Full per-lead context for a light lead that might go into the batch. */
  interface LightLeadCtx {
    lead: LeadRow;
    postText: string;
    payload: {
      text?: string; url?: string; authorName?: string | null; authorHeadline?: string | null;
      authorPublicId?: string | null; reactions?: number | null; comments?: number | null;
      reactionCount?: number | null; commentCount?: number | null;
      source?: string;
      images?: string[];
    };
    anchors: Array<{ snippet: string; score: number }>;
    knowledgeAnchors: string[];
    imageCaption: string;
    personDirective: string | null;
    commentDigest: string;
    routing: ModelRouting;
    useSmartest: boolean;
    styleForLead: StyleForPrompt | null;
    postRegister: PostRegister;
    /** Faithful-voice mode (operator pinned a source) — carried alongside postRegister. */
    faithful: boolean;
    registerBlock: string | undefined;
    /**
     * The standalone "THIS REPLY'S ASSIGNED SHAPE" block, for a lead whose shape
     * could NOT be rendered inside the faithful style block (no pinned voice, or
     * no style pool). Mutually exclusive with registerBlock.
     */
    shapeBlock: string | undefined;
    /**
     * Whether a shape was assigned AT ALL (inline in the style block OR
     * standalone). The closing length line in the user prompt keys off this: a
     * fixed char band printed under an assigned shape silently overrides it.
     */
    shapeAssigned: boolean;
    openingMoveBlock: string | undefined;
    /**
     * The gen-z "SPOKEN REGISTER" marker block, or undefined on the majority of
     * leads that are offered no marker. See @noelle/runtime genzMarkers.ts.
     */
    genzBlock: string | undefined;
    priorReplies: string[];
    replyRequest: ReplyRequestMeta | null;
  }

  // Two buckets after categorization:
  // - batchable: light, non-Opus, no-verifier, batch on → go to batch call
  // - singles: everything else (substantial, Opus-eligible lights, verifier-on lights)
  const batchableLights: LightLeadCtx[] = [];
  const singleLeads: Array<{
    lead: LeadRow;
    replyKind: "substantial" | "light";
    gatherLight?: () => Promise<LightLeadCtx>;
    replyRequest?: ReplyRequestMeta | null;
    // Substantial leads have their own ctx inline in the loop below
  }> = [];

  for (const lead of claimedLeads) {
    const replyKind: "substantial" | "light" =
      lead.classifier_label === "light" ? "light" : "substantial";
    const payload = lead.payload as {
      text?: string; url?: string; authorName?: string | null; authorHeadline?: string | null;
      authorPublicId?: string | null; reactions?: number | null; comments?: number | null;
      reactionCount?: number | null; commentCount?: number | null;
      source?: string;
      images?: string[];
    };
    const replyRequest = readReplyRequest(payload as Record<string, unknown>);

    // Cap gate uses the pre-compute shadow (budgetLeft) so leads accepted earlier
    // in this same pass are counted — matching the original sequential loop.
    if (!replyRequest && budgetLeft[replyKind] <= 0) {
      // Logged in aggregate after the loop, not per lead: the drafter re-claims
      // the same capped leads every tick, so a per-lead line here produced tens
      // of thousands of identical entries a day once a cap was reached.
      capDeferred[replyKind].push(lead.id);
      await deferLeadToClassified({ sql, leadId: lead.id, replyKind });
      continue;
    }

    // Org spend cap already tripped this tick — defer WITHOUT doing the paid
    // pre-draft gathering below (see `budgetBlown`).
    if (budgetBlown) {
      await deferLeadToClassified({ sql, leadId: lead.id, replyKind, reason: "budget" });
      continue;
    }

    const postText = payload.text ?? "";
    if (!postText) {
      await markStatus({ leadId: lead.id, status: "skipped", meta: { skip_reason: "empty post text" } });
      continue;
    }

    // NOTIFICATION TRIAGE (see the X twin + docs/notifications-actor.md). A
    // lead the actuator harvested because someone replied to us does not
    // automatically deserve a reply: most inbound is a thanks, and a few are
    // real opportunities where an agent answering is the wrong outcome. Runs
    // before any retrieval so an ignored lead costs zero LLM spend.
    if (!replyRequest && (payload as { source?: string }).source === "notification") {
      const decision = triageNotification({
        text: postText,
        author: payload.authorPublicId ?? lead.author_handle,
        priorTurns: Number((payload as { prior_turns?: number }).prior_turns ?? 0),
      });
      if (decision.verdict !== "reply") {
        let pinned = false;
        if (decision.verdict === "pin" && args.pinNotification) {
          const pin = renderPin({
            platform: "linkedin",
            author: payload.authorPublicId ?? lead.author_handle,
            text: postText,
            reason: decision.reason,
          });
          pinned = await args
            .pinNotification({ ...pin, url: (payload as { url?: string }).url ?? undefined })
            .catch((err) => {
              log.warn({ err: (err as Error).message }, "notification pin failed");
              return false;
            });
        }
        // An UNDELIVERED pin is never filed as 'skipped' — see the X twin. A
        // real opportunity with no reply AND no push is the worst outcome this
        // feature can produce, so it surfaces as 'errored' instead.
        const undeliveredPin = decision.verdict === "pin" && !pinned;
        if (undeliveredPin) {
          log.error(
            { leadId: lead.id, reason: decision.reason },
            "notification pin NOT delivered — leaving the lead visible",
          );
        }
        log.info({ leadId: lead.id, verdict: decision.verdict, reason: decision.reason, pinned }, "notification triage");
        await markStatus({
          leadId: lead.id,
          status: undeliveredPin ? "errored" : "skipped",
          meta: {
            skip_reason: `triage:${decision.verdict}:${decision.reason}`,
            ...(decision.verdict === "pin" ? { pin_delivered: pinned } : {}),
          },
        });
        continue;
      }
    }

    // For substantial leads, defer context-gathering to the singles loop below
    // (they always go single-call). Reserve the budget slot now (budgetLeft)
    // so subsequent leads in this pre-compute pass see the right cap.
    // remaining.substantial is decremented by the singles loop only on actual
    // successful drafts — no double-counting.
    if (replyKind === "substantial") {
      singleLeads.push({ lead, replyKind, replyRequest });
      if (!replyRequest) budgetLeft.substantial--;
      continue;
    }

    const engagement = leadEngagement(payload);
    const decision = decideOpus({
      likes: engagement.likes,
      comments: engagement.comments,
      commentBait: lead.comment_bait ?? false,
      likesThreshold: opusLikesThreshold,
      commentsThreshold: opusCommentsThreshold,
    });
    const useSmartest = decision.useOpus;
    // Repair review needs a per-lead model call; browser and explicit requests
    // also retain their single-call path.
    const canBatch = payload.source !== "extension_observed" && !replyRequest && batchingEnabled && !useSmartest && !verify?.enabled;
    const gatherLight = async (): Promise<LightLeadCtx> => {
      const browserObserved = payload.source === "extension_observed";
      const anchorDirs = browserObserved ? browserVoiceDirs : voiceDirs;
      const anchors = browserObserved && browserVoiceDirs.length === 0
        ? []
        : await retrieveAnchors(kb, postText, {
            topK: 8,
            ...(anchorDirs && anchorDirs.length ? { filterDirs: anchorDirs } : {}),
            rerank: rerankGrounding,
          }).catch((err) => {
            log.warn({ err: (err as Error).message }, "knowledge base search failed; drafting with no anchors");
            return [];
          });
      const knowledge =
        payload.source !== "extension_observed" && knowledgeDirs && knowledgeDirs.length && knowledgeTopK > 0
          ? await retrieveAnchors(kb, postText, {
              topK: knowledgeTopK,
              filterDirs: knowledgeDirs,
              rerank: rerankGrounding,
            }).catch((err) => {
                log.warn({ err: (err as Error).message }, "knowledge retrieval failed; drafting without product knowledge");
                return [];
              })
          : [];
      const knowledgeAnchors = knowledge.map((k) => k.snippet);
      const imageCaption = await captionImages({
        imageUrls: payload.images ?? [],
        postText,
        ...(captionFn ? { captionFn } : {}),
      });
      const fsd = lead.author_id ?? "";
      const publicIdKey = (payload.authorPublicId ?? lead.author_handle ?? "").trim().toLowerCase();
      // fsd first; fall back to the slug because keyword-lane leads carry no
      // author_id at all, so an fsd-only lookup can never find their profile.
      const profile =
        (fsd ? profilesByFsd.get(fsd) : undefined) ??
        (publicIdKey ? profilesByFsd.get(publicIdKey) : undefined);
      const personObj = publicIdKey ? objectivesByPublicId.get(publicIdKey) : undefined;
      const personDirective = buildPersonDirective(payload, profile, personObj);
      const postRegister = detectPostRegister(postText, lead.classifier_label);
      // Faithful multi-voice: when more than one voice is pinned, restrict THIS
      // lead's exemplar pool to the ONE voice picked for it (rotating across the
      // feed via pickFaithfulVoice) so the reply sounds like a single real writer,
      // not a blend. A single pinned voice needs no filter; a chosen voice with no
      // corpus fails open to the full pool.
      const styleCandidatesForLead =
        styleFaithful && faithfulVoices.length > 1
          ? (() => {
              const chosen = pickFaithfulVoice(faithfulVoices, postText, faithfulVoiceWeights);
              const filtered = styleCandidates.filter((c) => c.account_handle === chosen);
              return filtered.length ? filtered : styleCandidates; // fail-open if chosen voice has no corpus
            })()
          : styleCandidates;
      const styleForLead: StyleForPrompt | null = style?.enabled
        ? await selectStyleExemplars(postText, styleCandidatesForLead, styleProfiles, {
            enabled: true,
            config: style.config,
            // Faithful mode: pass undefined so the selector uses the legacy fit×perf
            // path (the pinned voice's characteristic/high-performing posts are
            // selected instead of being cheer-penalized on a "neutral" post).
            postRegister: styleFaithful ? undefined : postRegister,
            ...(style.dense !== undefined ? { dense: style.dense } : {}),
            ...(style.rng ? { rng: style.rng } : {}),
          })
        : null;
      const routing: ModelRouting = useSmartest
        ? opusOverrideRouting(baseRouting, opusModel)
        : baseRouting;
      log.info(
        {
          leadId: lead.id,
          priority: lead.priority,
          likes: decision.likes,
          comments: decision.comments,
          comment_bait: decision.commentBait,
          useOpus: useSmartest,
          opus_reason: decision.useOpus ? "high_engagement" : null,
          model: routing.primary.model,
        },
        useSmartest ? "drafter using Opus for high-engagement light lead" : "drafter using default model for light lead",
      );
      const commentDigest = await fetchCommentDigest({
        lead, payload: { url: payload.url, comments: engagement.comments }, fetchPostComments,
        maxComments: commentFetchMax, minCount: commentFetchMinCount, log,
      });
      // Form-variant rotation: assign this reply ONE of the SHAPE variants (never
      // the previous pick's) and let it own length/structure. Register +
      // opening-move are suppressed for the lead so the prompt carries ONE shape
      // instruction, not three contradicting ones. The light lane excludes
      // shapes that can't carry a congrats (QUESTION_ONLY).
      //
      // The shape fires on EVERY lead, not only pinned-voice ones. It used to be
      // gated on `styleFaithful && styleForLead` because the directive was
      // rendered INSIDE the faithful style block, so a lead with no pinned voice
      // silently got no shape and fell back to the fixed "~90-180 chars" line at
      // the bottom of the user prompt. That is exactly why Lyra's feed came out
      // one length: measured over 30 days her replies sat at 181 +/- 44 chars
      // while Vega's, which has had a standalone block since #498, spread
      // 131 +/- 58. Where there IS a pinned voice the shape still renders inline
      // (so it replaces the faithful block's own hook-then-line recipe rather
      // than fighting it); everywhere else it renders as its own block.
      // TONE-FIRST lane (mirrors Vega's, apps/x-intern/.../drafter-tick.ts): on a
      // CELEBRATION post, mirroring the ENERGY beats varying the form, so the
      // register (HYPE, "LETS GOOO") wins that lead and no shape is assigned.
      // Exception: when the operator PINNED a voice, the shape renders inside
      // the faithful style block and replaces its fixed hook-then-line recipe —
      // dropping it there would hand the recipe back, which is the thing the
      // rotation exists to kill. Everything else (the neutral, analytical bulk
      // of the feed, i.e. every substantial lead) gets a shape.
      const toneFirst = postRegister === "celebration" && !(styleFaithful && styleForLead);
      // Half of the tone-first leads now take a shape after all, drawn only
      // from the shapes that can carry a celebration (see Vega's split and
      // ENERGY_SHAPE_IDS). Leaving the whole lane shapeless meant every win in
      // the feed came out in one length band. The register still wins the other
      // half, because HYPE's CAPS is a thing no shape can express.
      const toneFirstShape =
        toneFirst && variety?.enabled
          ? (variety.rng ?? Math.random)() < TONE_FIRST_SHAPE_SHARE
          : false;
      const formVariant =
        variety?.enabled && (!toneFirst || toneFirstShape)
          ? (variety.formVariantRotation ?? formVariantRotation).next(variety.rng, [
              ...LIGHT_EXCLUDED_VARIANT_IDS,
              ...(toneFirstShape ? shapesExcludedForEnergy("celebration") : []),
              ...(browserObserved ? BROWSER_OBSERVED_EXCLUDED_VARIANT_IDS : []),
            ])
          : undefined;
      const shapeInStyleBlock = Boolean(formVariant && styleFaithful && styleForLead);
      if (formVariant && shapeInStyleBlock && styleForLead) {
        styleForLead.formVariant = { id: formVariant.id, directive: formVariant.directive };
      }
      const shapeBlock =
        formVariant && !shapeInStyleBlock ? renderAssignedShapeBlock(formVariant) : undefined;
      const registerBlock =
        variety?.enabled && !formVariant
          ? renderRegisterBlock(pickRegisterForPost(postRegister, variety.rng))
          : undefined;
      const openingMoveBlock =
        variety?.enabled && !formVariant ? renderOpeningMoveBlock(pickOpeningMove(variety.rng)) : undefined;
      const genzBlock = pickGenzBlock(variety, postRegister);
      const priorReplies = getPriorReplies
        ? await getPriorReplies({
            authorHandle: payload.authorPublicId ?? lead.author_handle,
            authorId: lead.author_id,
            excludeLeadId: lead.id,
            limit: priorRepliesTopK,
          }).catch(() => [])
        : [];

      return {
        lead, postText, payload, anchors, knowledgeAnchors, imageCaption,
        personDirective, commentDigest, routing, useSmartest, styleForLead,
        registerBlock, shapeBlock, shapeAssigned: Boolean(formVariant),
        openingMoveBlock, genzBlock, priorReplies, postRegister,
        faithful: styleFaithful,
        replyRequest,
      };
    };
    try {
      if (canBatch) {
        batchableLights.push(await gatherLight());
      } else {
        singleLeads.push({ lead, replyKind, gatherLight });
      }
      // Reserve the light budget slot so the next lead in this pass sees the
      // right cap (mirrors how the original sequential loop worked).
      if (!replyRequest) budgetLeft.light--;
    } catch (err) {
      if (err instanceof BudgetExceededError) {
        log.warn(
          { leadId: lead.id, layer: err.layer, spent_cents: err.spentCents, cap_cents: err.capCents },
          "drafter blocked by budget cap; deferring lead, will retry",
        );
        budgetBlown = true;
        await deferLeadToClassified({ sql, leadId: lead.id, replyKind: "light", reason: "budget" });
        continue;
      }
      log.error({ leadId: lead.id, err: (err as Error).message }, "drafter tick failed for light lead during pre-compute");
      await markStatus({ leadId: lead.id, status: "errored", meta: { error: (err as Error).message } });
    }
  }

  // One line per kind per tick, instead of one per deferred lead (see cap gate).
  for (const kind of ["substantial", "light"] as const) {
    const ids = capDeferred[kind];
    if (ids.length === 0) continue;
    log.info(
      {
        replyKind: kind,
        cap: kind === "light" ? lightCap : substantialCap,
        deferred: ids.length,
        leadIds: ids.slice(0, 20),
      },
      "daily draft cap reached for kind; leaving leads classified for a later day",
    );
  }

  // ── Batched LIGHT path ────────────────────────────────────────────────────
  // One call for all batchable light leads. Fail-open: any parse failure /
  // count mismatch / id mismatch / model error → fall back to per-lead single
  // calls so no lead is dropped or cross-wired.
  if (batchableLights.length > 0) {
    const batchIds = batchableLights.map((ctx) => ctx.lead.id);
    log.info({ count: batchableLights.length, ids: batchIds }, "drafter: running batched light call");
    let batchFellBack = false;
    let batchResult: { replies: z.infer<typeof BatchedLightOutput>; engine: string; model: string } | null = null;
    try {
      // Build the batched inputs (one per lead with its own context).
      // renderStyleBlock is sync (already imported at the top of this file).
      const batchInputs: BatchedLightLeadInput[] = batchableLights.map((ctx) => ({
        id: ctx.lead.id,
        postText: ctx.postText,
        authorName: ctx.payload.authorName ?? null,
        publicId: ctx.payload.authorPublicId ?? ctx.lead.author_handle ?? null,
        styleBlock: ctx.styleForLead ? renderStyleBlock(ctx.styleForLead, ctx.postRegister, ctx.faithful) : "",
        anchors: ctx.anchors.map((a) => a.snippet),
        knowledgeAnchors: ctx.knowledgeAnchors,
        imageCaption: ctx.imageCaption,
        commentDigest: ctx.commentDigest,
        registerBlock: ctx.registerBlock,
        // The per-lead SHAPE. Without this the batched lane was the one place a
        // light reply still had no form directive at all, so batched drafts all
        // came back at the suffix's default ~90-180 band.
        shapeBlock: ctx.shapeBlock,
        openingMoveBlock: ctx.openingMoveBlock,
        genzBlock: ctx.genzBlock,
        priorReplies: ctx.priorReplies,
        recentPhrasings,
      }));

      // Use the base routing (never Opus — all batchable leads are non-Opus).
      // The batched system prompt = the light drafter system + the batched-mode suffix.
      const batchSystem =
        buildLightDrafterSystem(instance.objective, null, brand, null) +
        BATCHED_LIGHT_SYSTEM_SUFFIX;
      const batchPrompt = renderBatchedLightUserPrompt(batchInputs);

      const res = await runner.draft({
        bucket: "drafter-codex",
        routing: baseRouting,
        orgId: instance.org_id,
        instanceId: instance.id,
        worker: "drafter" as const,
        agentRole: "linkedin_intern" as const,
        system: batchSystem,
        prompt: batchPrompt,
      });

      // Parse: expect a JSON array. Try bracket-extraction on failure.
      const parsed = parseBatchedLightOutput(res.text, batchableLights.length, batchIds, log);
      if (!parsed) {
        log.warn(
          { count: batchableLights.length, raw: res.text.slice(0, 300) },
          "batched light: parse failed — falling back to per-lead single calls",
        );
        batchFellBack = true;
      } else {
        batchResult = { replies: parsed, engine: res.engine, model: res.model };
      }
    } catch (err) {
      if (err instanceof BudgetExceededError) {
        log.warn(
          { layer: err.layer, spent_cents: err.spentCents, cap_cents: err.capCents },
          "batched light: blocked by budget cap; deferring the batch, will retry",
        );
        // The batch call is what proved the org cap is spent, so record it here:
        // the fallback below then defers every batched lead without re-trying a
        // call we already know throws. (Non-budget failures still fall back and
        // retry per lead — that path is unchanged.)
        budgetBlown = true;
        batchFellBack = true;
      } else {
        log.warn(
          { err: (err as Error).message },
          "batched light: call threw — falling back to per-lead single calls",
        );
        batchFellBack = true;
      }
    }

    if (batchResult) {
      // Success: distribute results back to each lead.
      const replyByLeadId = new Map(batchResult.replies.map((e) => [e.id, e.reply]));
      for (const ctx of batchableLights) {
        let posted = false;
        try {
          const body = replyByLeadId.get(ctx.lead.id);
          if (!body) {
            // id missing from output — treat as schema miss, error the lead.
            log.error(
              { leadId: ctx.lead.id },
              "batched light: reply missing from batch output; marking errored",
            );
            await markStatus({ leadId: ctx.lead.id, status: "errored", meta: { error: "batch_id_missing" } });
            continue;
          }
          // Apply the same reply policy against this member's own post.
          const [policed] = applyReplyEmojiPolicy(
            [
              {
                id: randomUUID(),
                kind: "reply" as const,
                angle: "empathetic" as const,
                body,
              },
            ],
            ctx.postText,
          );
          if (!policed) {
            // Nothing sendable left. Skip THIS lead and keep going: an empty
            // body must never take the rest of the batch down with it.
            log.warn(
              { leadId: ctx.lead.id },
              "batched light: reply was emoji-only and cleaned to empty; skipping this lead",
            );
            await markStatus({ leadId: ctx.lead.id, status: "skipped", meta: { reason: "empty-after-emoji-policy" } });
            continue;
          }
          if (makesCommitment(policed.body)) {
            const reason = commitmentReason(detectCommitments(policed.body)) || "commitment-guard";
            log.warn({ leadId: ctx.lead.id, reason }, "commitment guard dropped a batched light reply");
            await markStatus({ leadId: ctx.lead.id, status: "skipped", meta: { skip_reason: reason } });
            continue;
          }
          const replyRow = { ...policed, charCount: [...policed.body].length };
          const batchedOutbound = buildOutbound({
            lead: ctx.lead,
            postText: ctx.postText,
            payload: ctx.payload,
            anchors: ctx.anchors,
            drafts: [replyRow],
            verifierMeta: null,
            style: ctx.styleForLead,
          });
          if (!batchedOutbound) {
            log.warn({ leadId: ctx.lead.id }, "batched light: outbound empty; skipping this lead");
            await markStatus({ leadId: ctx.lead.id, status: "skipped", meta: { reason: "empty-after-emoji-policy" } });
            continue;
          }
          await postOutbound(batchedOutbound);
          posted = true;
          processed++;
          remaining.light--;
          await markStatus({
            leadId: ctx.lead.id,
            status: "drafted",
            meta: { engine: batchResult.engine, model: batchResult.model, reply_kind: "light", batched: true },
          });
          await bus?.emit({
            topic: "draft.created",
            worker: "drafter",
            summary: "drafted light reply (batched)",
            payload: { lead_id: ctx.lead.id, reply_kind: "light", tier: ctx.lead.tier ?? null, batched: true },
            correlationId: ctx.lead.id,
          });
        } catch {
          log.error({ leadId: ctx.lead.id, posted }, "batched light: member failed; retaining other results");
          if (!posted) {
            await markStatus({ leadId: ctx.lead.id, status: "errored", meta: { error: "batch_member_failed" } })
              .catch(() => log.warn({ leadId: ctx.lead.id }, "batched light: failed member status unavailable"));
          }
        }
      }
    }

    if (batchFellBack) {
      // Fallback: process each batchable lead individually (today's behaviour).
      for (const ctx of batchableLights) {
        // Same org-wide short-circuit as the other two loops. These leads were
        // gathered during pre-compute (ctx is cached), so this re-pays nothing
        // — it just avoids N pointless pre-flight checks and defer writes.
        if (budgetBlown) {
          await deferLeadToClassified({
            sql, leadId: ctx.lead.id, replyKind: "light", reason: "budget",
          });
          continue;
        }
        try {
          const ok = await draftLight({
            voiceExemplars: args.voiceExemplars,
            lead: ctx.lead,
            postText: ctx.postText,
            payload: ctx.payload,
            anchors: ctx.anchors,
            knowledgeAnchors: ctx.knowledgeAnchors,
            imageCaption: ctx.imageCaption,
            personDirective: ctx.personDirective,
            commentDigest: ctx.commentDigest,
            brand,
            instance,
            routing: ctx.routing,
            opusRepairRouting,
            runner,
            postOutbound,
            markStatus,
            log,
            verify,
            registerBlock: ctx.registerBlock,
            shapeBlock: ctx.shapeBlock,
            shapeAssigned: ctx.shapeAssigned,
            openingMoveBlock: ctx.openingMoveBlock,
            genzBlock: ctx.genzBlock,
            priorReplies: ctx.priorReplies,
            recentPhrasings,
            replyRequest: ctx.replyRequest,
            style: ctx.styleForLead,
            postRegister: ctx.postRegister,
            faithful: ctx.faithful,
            patternRules,
          });
          if (ok) {
            processed++;
            remaining.light--;
            await bus?.emit({
              topic: "draft.created",
              worker: "drafter",
              summary: "drafted light reply (batch-fallback)",
              payload: { lead_id: ctx.lead.id, reply_kind: "light", tier: ctx.lead.tier ?? null },
              correlationId: ctx.lead.id,
            });
          }
        } catch (err) {
          if (err instanceof BudgetExceededError) {
            log.warn(
              { leadId: ctx.lead.id, layer: err.layer, spent_cents: err.spentCents },
              "drafter blocked by budget cap (batch-fallback); deferring lead, will retry",
            );
            budgetBlown = true;
            await deferLeadToClassified({
              sql, leadId: ctx.lead.id, replyKind: "light", reason: "budget",
            });
          } else {
            log.error(
              { leadId: ctx.lead.id, err: (err as Error).message },
              "drafter tick failed for light lead (batch-fallback)",
            );
            await markStatus({ leadId: ctx.lead.id, status: "errored", meta: { error: (err as Error).message } });
          }
        }
      }
    }
  }

  // ── Single-call path (substantial + non-batchable lights) ─────────────────
  for (const { lead, replyKind, gatherLight, replyRequest: substantialReplyRequest } of singleLeads) {
    // Org spend cap already tripped — defer the rest without paying for their
    // pre-draft gathering (see `budgetBlown`).
    if (budgetBlown) {
      await deferLeadToClassified({ sql, leadId: lead.id, replyKind, reason: "budget" });
      continue;
    }
    const payload = lead.payload as {
      text?: string; url?: string; authorName?: string | null; authorHeadline?: string | null;
      authorPublicId?: string | null; reactions?: number | null; comments?: number | null;
      source?: string;
      images?: string[];
    };
    const postText = payload.text ?? "";
    if (!postText) {
      await markStatus({ leadId: lead.id, status: "skipped", meta: { skip_reason: "empty post text" } });
      continue;
    }

    if (replyKind === "light" && gatherLight) {
      try {
        const lightCtx = await gatherLight();
        const ok = await draftLight({
            voiceExemplars: args.voiceExemplars,
          lead: lightCtx.lead,
          postText: lightCtx.postText,
          payload: lightCtx.payload,
          anchors: lightCtx.anchors,
          knowledgeAnchors: lightCtx.knowledgeAnchors,
          imageCaption: lightCtx.imageCaption,
          personDirective: lightCtx.personDirective,
          commentDigest: lightCtx.commentDigest,
          brand,
          instance,
          routing: lightCtx.routing,
          opusRepairRouting,
          runner,
          postOutbound,
          markStatus,
          log,
          verify,
          registerBlock: lightCtx.registerBlock,
          shapeBlock: lightCtx.shapeBlock,
          shapeAssigned: lightCtx.shapeAssigned,
          openingMoveBlock: lightCtx.openingMoveBlock,
          genzBlock: lightCtx.genzBlock,
          priorReplies: lightCtx.priorReplies,
          recentPhrasings,
          replyRequest: lightCtx.replyRequest,
          style: lightCtx.styleForLead,
          postRegister: lightCtx.postRegister,
          faithful: lightCtx.faithful,
          patternRules,
        });
        if (ok) {
          processed++;
          remaining.light--;
          await bus?.emit({
            topic: "draft.created",
            worker: "drafter",
            summary: "drafted light reply",
            payload: { lead_id: lead.id, reply_kind: "light", tier: lead.tier ?? null },
            correlationId: lead.id,
          });
        }
      } catch (err) {
        if (err instanceof BudgetExceededError) {
          log.warn(
            { leadId: lead.id, layer: err.layer, spent_cents: err.spentCents, cap_cents: err.capCents },
            "drafter blocked by budget cap; deferring lead, will retry",
          );
          budgetBlown = true;
          await deferLeadToClassified({ sql, leadId: lead.id, replyKind: "light", reason: "budget" });
        } else {
          log.error({ leadId: lead.id, err: (err as Error).message }, "drafter tick failed for light lead");
          await markStatus({ leadId: lead.id, status: "errored", meta: { error: (err as Error).message } });
        }
      }
      continue;
    }

    // SUBSTANTIAL path: gather context here (we deferred it above).
    try {
      // Browser qualification already ran through Jev. Keep its voice lookup
      // inside curated folders, and avoid a whole-vault search when none exist.
      const browserObserved = payload.source === "extension_observed";
      const anchorDirs = browserObserved ? browserVoiceDirs : voiceDirs;
      const anchors = browserObserved && browserVoiceDirs.length === 0
        ? []
        : await retrieveAnchors(kb, postText, {
            topK: 8,
            ...(anchorDirs && anchorDirs.length ? { filterDirs: anchorDirs } : {}),
            rerank: rerankGrounding,
          }).catch((err) => {
            log.warn({ err: (err as Error).message }, "knowledge base search failed; drafting with no anchors");
            return [];
          });

      // Retrieval-score gate. LIGHT leads bypass it — a short congrats doesn't
      // need a voice anchor. SUBSTANTIAL leads must clear the threshold (anchors
      // are still fetched for voice grounding).
      //
      // NOTIFICATION leads bypass it entirely. The gate asks "do we have
      // something relevant to say about this STRANGER's post?" — the right
      // question for cold outbound, and the wrong one for somebody replying to
      // US. Relevance to our vault does not decide whether a person already
      // mid-conversation with us deserves an answer, and going quiet on them is
      // the exact failure the notifications actor exists to fix. Same reasoning
      // as migration 0091 exempting these leads from the cold-reply age ceiling:
      // that ceiling is about not answering stale STRANGERS.
      //
      // Keyed on source, NOT on `lead.priority`, even though the X twin uses
      // priority for its version of this bypass. The flag does not mean the same
      // thing on the two platforms: on X it marks watchlist leads and most leads
      // are priority=false, so it is a selective gate. On LinkedIn essentially
      // EVERY lead is priority=true (profile_search, keyword and discovery all
      // set it), so `!lead.priority` would silently switch the relevance gate
      // off for the whole pipeline and flood the queue with low-relevance cold
      // outbound. Measured before choosing this: 1,340 non-notification priority
      // leads in the last 14 days versus 17 notification ones.
      const isNotification = (payload as { source?: string }).source === "notification";
      const replyRequest = substantialReplyRequest ?? readReplyRequest(payload as Record<string, unknown>);
      const topAnchorScore = anchors.length === 0 ? 0 : Math.max(...anchors.map((a) => a.score));
      // Browser observations passed Jev's strict qualification already. A
      // missing curated voice folder must not make that lead disappear here.
      if (!replyRequest && !isNotification && !browserObserved && replyKind === "substantial" && topAnchorScore < relevanceThreshold) {
        log.info(
          { leadId: lead.id, topAnchorScore, relevanceThreshold },
          "drafter skipped substantial lead below relevance threshold",
        );
        await markStatus({
          leadId: lead.id,
          status: "skipped",
          meta: {
            skip_reason: `below-relevance-threshold (score=${topAnchorScore.toFixed(3)} < ${relevanceThreshold})`,
            top_anchor_score: topAnchorScore,
            relevance_threshold: relevanceThreshold,
          },
        });
        continue;
      }

      // Second, KNOWLEDGE retrieval pass: scoped to product/positioning vault
      // dirs, so the drafter can ground factual claims about the offer instead of
      // inventing them from model priors. Skipped entirely when no knowledge dirs
      // are configured (managed/live default). Fail-open to no knowledge.
      const knowledge =
        payload.source !== "extension_observed" && knowledgeDirs && knowledgeDirs.length && knowledgeTopK > 0
          ? await retrieveAnchors(kb, postText, {
              topK: knowledgeTopK,
              filterDirs: knowledgeDirs,
              rerank: rerankGrounding,
            }).catch((err) => {
                log.warn(
                  { err: (err as Error).message },
                  "knowledge retrieval failed; drafting without product knowledge",
                );
                return [];
              })
          : [];
      const knowledgeAnchors = knowledge.map((k) => k.snippet);

      // Optional visual context falls back to empty on ordinary failure.
      // Denied model admission propagates to the existing budget defer policy.
      const imageCaption = await captionImages({
        imageUrls: payload.images ?? [],
        postText,
        ...(captionFn ? { captionFn } : {}),
      });

      // The lead's author key: author_id is the fsd profile id, author_handle is
      // the public_id (vanity slug). Use both to find the person's profile + objective.
      const fsd = lead.author_id ?? "";
      const publicIdKey = (payload.authorPublicId ?? lead.author_handle ?? "").trim().toLowerCase();
      // fsd first; fall back to the slug because keyword-lane leads carry no
      // author_id at all, so an fsd-only lookup can never find their profile.
      const profile =
        (fsd ? profilesByFsd.get(fsd) : undefined) ??
        (publicIdKey ? profilesByFsd.get(publicIdKey) : undefined);
      const personObj = publicIdKey ? objectivesByPublicId.get(publicIdKey) : undefined;
      const personDirective = buildPersonDirective(payload, profile, personObj);

      // Account Feeder STYLE: sample a few high-performing human exemplars for
      // THIS lead (performance-weighted × fit, controlled variety) from the
      // once-per-tick pool. Null when style is off / the pool is empty / anything
      // errors (selectStyleExemplars is itself fail-open) → no STYLE block, the
      // lead drafts exactly as today. Comments only — the DM is untouched.
      const postRegister = detectPostRegister(postText, lead.classifier_label);
      // Faithful multi-voice: when more than one voice is pinned, restrict THIS
      // lead's exemplar pool to the ONE voice picked for it (rotating across the
      // feed via pickFaithfulVoice) so the reply sounds like a single real writer,
      // not a blend. A single pinned voice needs no filter; a chosen voice with no
      // corpus fails open to the full pool.
      const styleCandidatesForLead =
        styleFaithful && faithfulVoices.length > 1
          ? (() => {
              const chosen = pickFaithfulVoice(faithfulVoices, postText, faithfulVoiceWeights);
              const filtered = styleCandidates.filter((c) => c.account_handle === chosen);
              return filtered.length ? filtered : styleCandidates; // fail-open if chosen voice has no corpus
            })()
          : styleCandidates;
      const styleForLead: StyleForPrompt | null = style?.enabled
        ? await selectStyleExemplars(postText, styleCandidatesForLead, styleProfiles, {
            enabled: true,
            config: style.config,
            // Faithful mode: pass undefined so the selector uses the legacy fit×perf
            // path (the pinned voice's characteristic/high-performing posts are
            // selected instead of being cheer-penalized on a "neutral" post).
            postRegister: styleFaithful ? undefined : postRegister,
            ...(style.dense !== undefined ? { dense: style.dense } : {}),
            ...(style.rng ? { rng: style.rng } : {}),
          })
        : null;

      // Model tiering is reaction-based ONLY: Opus is reserved for genuinely
      // high-engagement posts (decideOpus on likes/comments). Watchlist/priority
      // leads no longer force Opus — a routine connection reply drafts on the
      // default (Sonnet) model, which is ~6x cheaper for no measurable quality
      // loss. A high-engagement watchlist post still upgrades via decideOpus.
      const engagement = leadEngagement(payload);
      const decision = decideOpus({
        likes: engagement.likes,
        comments: engagement.comments,
        commentBait: lead.comment_bait ?? false,
        likesThreshold: opusLikesThreshold,
        commentsThreshold: opusCommentsThreshold,
      });
      const useSmartest = decision.useOpus;
      const routing: ModelRouting = useSmartest
        ? opusOverrideRouting(baseRouting, opusModel)
        : baseRouting;
      log.info(
        {
          leadId: lead.id,
          priority: lead.priority,
          likes: decision.likes,
          comments: decision.comments,
          comment_bait: decision.commentBait,
          useOpus: useSmartest,
          opus_reason: decision.useOpus ? "high_engagement" : null,
          model: routing.primary.model,
        },
        useSmartest
          ? "drafter using Opus for high-engagement lead"
          : "drafter using default model for lead",
      );

      // Comment-energy: read the existing comments on the post so the draft can
      // match the room and avoid echoing the crowd. Gated on a known comment
      // count (no point paying to read an empty section) and fail-open. Records
      // each paid attempt through the caller's metered fetch.
      const commentDigest = await fetchCommentDigest({
        lead,
        payload: { url: payload.url, comments: engagement.comments },
        fetchPostComments,
        maxComments: commentFetchMax,
        minCount: commentFetchMinCount,
        log,
      });

      // Form-variant rotation (same contract as the light path): the assigned
      // SHAPE owns length/structure for this lead's comments, and the register +
      // opening-move blocks are suppressed so the prompt carries ONE shape
      // instruction. Fires on every lead — see the light path above for why the
      // old `styleFaithful && styleForLead` gate is what flattened the feed.
      // TONE-FIRST lane (mirrors Vega's, apps/x-intern/.../drafter-tick.ts): on a
      // CELEBRATION post, mirroring the ENERGY beats varying the form, so the
      // register (HYPE, "LETS GOOO") wins that lead and no shape is assigned.
      // Exception: when the operator PINNED a voice, the shape renders inside
      // the faithful style block and replaces its fixed hook-then-line recipe —
      // dropping it there would hand the recipe back, which is the thing the
      // rotation exists to kill. Everything else (the neutral, analytical bulk
      // of the feed, i.e. every substantial lead) gets a shape.
      const toneFirst = postRegister === "celebration" && !(styleFaithful && styleForLead);
      // Same tone-first split as the light path above: half the celebrations
      // take a celebration-safe shape rather than leaving the whole lane in one
      // length band.
      const toneFirstShape =
        toneFirst && variety?.enabled
          ? (variety.rng ?? Math.random)() < TONE_FIRST_SHAPE_SHARE
          : false;
      const formVariant =
        variety?.enabled && (!toneFirst || toneFirstShape)
          ? (variety.formVariantRotation ?? formVariantRotation).next(variety.rng, [
              ...(toneFirstShape ? shapesExcludedForEnergy("celebration") : []),
              ...(browserObserved ? BROWSER_OBSERVED_EXCLUDED_VARIANT_IDS : []),
              // The substantial prompt asks for one draft PER ANGLE in a single
              // call and ONE shape governs all of them, so a shape that
              // prescribes a STANCE ("agree in four words or fewer")
              // contradicts the contrarian angle sitting beside it.
              //
              // TIER-AWARE, matching Orion's: T3 is ["empathetic"], a
              // single-draft prompt with nothing to contradict. Excluding
              // unconditionally made AGREE_EXTEND unreachable on every T3 lead
              // for no reason, and left the two siblings disagreeing.
              ...((TIER_ANGLES[lead.tier ?? "T3"]?.length ?? 1) > 1 ? STANCE_SHAPE_IDS : []),
            ])
          : undefined;
      const shapeInStyleBlock = Boolean(formVariant && styleFaithful && styleForLead);
      if (formVariant && shapeInStyleBlock && styleForLead) {
        styleForLead.formVariant = { id: formVariant.id, directive: formVariant.directive };
      }
      const shapeBlock =
        formVariant && !shapeInStyleBlock ? renderAssignedShapeBlock(formVariant) : undefined;

      // Voice variety: assign this lead a random register and inject it into the
      // COMMENT-drafting prompt, so comments vary across the feed. Off (or omitted)
      // → undefined, byte-identical to today. The DM is untouched. Applies to both
      // the substantial and light comment paths.
      const registerBlock =
        variety?.enabled && !formVariant
          ? renderRegisterBlock(pickRegisterForPost(postRegister, variety.rng))
          : undefined;

      // Voice variety, part two: assign a random OPENING MOVE (how the comment
      // starts) so openings don't all converge on the same lead-in. Same flag /
      // rng as the register; off → undefined. Comments only, DM untouched.
      const openingMoveBlock =
        variety?.enabled && !formVariant
          ? renderOpeningMoveBlock(pickOpeningMove(variety.rng))
          : undefined;

      // Voice variety, part three: on a minority of leads, offer ONE gen-z
      // marker the comment may use once, or drop. Word choice only, so unlike
      // the shape and the register it does not compete for the length slot and
      // is NOT suppressed when a shape is assigned.
      const genzBlock = pickGenzBlock(variety, postRegister);

      // Per-person memory: the replies Lyra already sent/queued to THIS author, so
      // the comment doesn't repeat a take it already made. Fail-open to [].
      const priorReplies = getPriorReplies
        ? await getPriorReplies({
            authorHandle: payload.authorPublicId ?? lead.author_handle,
            authorId: lead.author_id,
            excludeLeadId: lead.id,
            limit: priorRepliesTopK,
          }).catch(() => [])
        : [];

      // SUBSTANTIAL path.
      const tier: "T1" | "T2" | "T3" = lead.tier ?? "T3";
      const ok = await draftSubstantial({
            voiceExemplars: args.voiceExemplars,
        lead,
        tier,
        postText,
        payload,
        anchors,
        knowledgeAnchors,
        imageCaption,
        personDirective,
        commentDigest,
        brand,
        instance,
        routing,
        opusRepairRouting,
        runner,
        postOutbound,
        markStatus,
        log,
        verify,
        registerBlock,
        shapeBlock,
        shapeAssigned: Boolean(formVariant),
        openingMoveBlock,
        genzBlock,
        priorReplies,
        recentPhrasings,
        replyRequest,
        style: styleForLead,
        postRegister,
        faithful: styleFaithful,
        patternRules,
      });
      if (ok) {
        processed++;
        remaining.substantial--;
        await bus?.emit({
          topic: "draft.created",
          worker: "drafter",
          summary: "drafted substantial reply",
          payload: { lead_id: lead.id, reply_kind: "substantial", tier },
          correlationId: lead.id,
        });
      }
    } catch (err) {
      if (err instanceof BudgetExceededError) {
        log.warn(
          { leadId: lead.id, layer: err.layer, spent_cents: err.spentCents, cap_cents: err.capCents },
          "drafter blocked by budget cap; deferring lead, will retry",
        );
        budgetBlown = true;
        await deferLeadToClassified({
          // This loop carries BOTH kinds ("substantial + non-batchable lights"),
          // so the stamp must follow the lead, not be hardcoded.
          sql,
          leadId: lead.id,
          replyKind,
          reason: "budget",
        });
        continue;
      }
      log.error({ leadId: lead.id, err: (err as Error).message }, "drafter tick failed for lead");
      await markStatus({ leadId: lead.id, status: "errored", meta: { error: (err as Error).message } });
    }
  }
  return processed;
}

/**
 * Parse the batched-light model output. Tries to extract a JSON array from the
 * raw text (fence-stripped), validates with Zod, and checks that:
 *   - the array has exactly `expectedCount` entries
 *   - every expected id appears exactly once (no cross-wiring, no drops)
 * Returns null on ANY failure so the caller can fail-open to per-lead single calls.
 */
function parseBatchedLightOutput(
  raw: string,
  expectedCount: number,
  expectedIds: string[],
  log: { warn(obj: Record<string, unknown>, msg: string): void },
): Array<{ id: string; reply: string }> | null {
  // Try to extract a JSON array from the raw text.
  let parsed: unknown = null;
  // 1. Direct parse.
  try { parsed = JSON.parse(raw); } catch { /* fall through */ }
  // 2. Strip markdown fences.
  if (parsed === null) {
    try {
      const stripped = raw.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "");
      parsed = JSON.parse(stripped);
    } catch { /* fall through */ }
  }
  // 3. Extract first [...] block.
  if (parsed === null) {
    const firstBracket = raw.indexOf("[");
    const lastBracket = raw.lastIndexOf("]");
    if (firstBracket >= 0 && lastBracket > firstBracket) {
      try { parsed = JSON.parse(raw.slice(firstBracket, lastBracket + 1)); } catch { /* fall through */ }
    }
  }
  if (parsed === null) {
    log.warn({ raw: raw.slice(0, 200) }, "parseBatchedLightOutput: no JSON array found");
    return null;
  }

  // Validate with Zod.
  const zodResult = BatchedLightOutput.safeParse(parsed);
  if (!zodResult.success) {
    log.warn({ error: zodResult.error.message.slice(0, 200) }, "parseBatchedLightOutput: Zod validation failed");
    return null;
  }
  const entries = zodResult.data;

  // Length check.
  if (entries.length !== expectedCount) {
    log.warn(
      { expected: expectedCount, got: entries.length },
      "parseBatchedLightOutput: array length mismatch",
    );
    return null;
  }

  // Id match check: every expected id must appear exactly once.
  const returnedIds = new Set(entries.map((e) => e.id));
  for (const id of expectedIds) {
    if (!returnedIds.has(id)) {
      log.warn({ missingId: id }, "parseBatchedLightOutput: expected id missing from batch output");
      return null;
    }
  }
  if (returnedIds.size !== expectedIds.length) {
    log.warn(
      { expected: expectedIds.length, got: returnedIds.size },
      "parseBatchedLightOutput: duplicate ids in batch output",
    );
    return null;
  }

  return entries;
}

interface DraftCommonArgs {
  /**
   * The operator's approved replies paired with the posts they answered.
   * Fetched once per tick — the set barely moves between leads.
   */
  voiceExemplars?: ReadonlyArray<{ post: string; reply: string }>;

  lead: LeadRow;
  postText: string;
  payload: {
    text?: string;
    url?: string;
    authorName?: string | null;
    authorHeadline?: string | null;
    authorPublicId?: string | null;
    source?: string;
  };
  anchors: Array<{ snippet: string; score: number }>;
  /** Product-knowledge snippets from the second (scoped) retrieval pass. [] when off. */
  knowledgeAnchors: string[];
  /** One-line description of the post's image(s), or "" when none / vision off. */
  imageCaption: string;
  personDirective: string | null;
  /** The COMMENT SECTION block (existing comments on the post), or "" when none. */
  commentDigest: string;
  brand: ReturnType<typeof parseBrandConfig>;
  /** The post's register (celebration | neutral) for register-aware STYLE + variety. */
  postRegister: PostRegister;
  /**
   * Faithful-voice mode (operator pinned a style source). When true, the STYLE
   * block adopts the pinned writer's voice instead of the faint FORM-only echo.
   * Undefined/false ⇒ byte-identical to before. Carried alongside postRegister.
   */
  faithful?: boolean;
  instance: ActiveInstance;
  /** The model routing for THIS lead's draft call (Opus-overridden when high-engagement). */
  routing: ModelRouting;
  /** Opus with the ordinary instance writer preserved as its fallback. */
  opusRepairRouting: ModelRouting;
  runner: CodexRunner;
  postOutbound: (body: OutboundIn) => Promise<{ id: string; approval_id: string }>;
  markStatus: (args: { leadId: string; status: "drafted" | "errored" | "skipped"; meta?: Record<string, unknown> }) => Promise<void>;
  log: Logger;
  /** Post-draft verifier (off by default). Applies to both substantial + light. */
  verify?: {
    enabled: boolean;
    retries: number;
    makeCalls: VerifierCallFactory;
    /**
     * Voice floor (0-1). When the verifier ran and the best attempt's voice
     * score is BELOW this after all retries, the draft is DROPPED (lead skipped
     * with skip_reason='low-voice') instead of served — the operator would
     * rather get nothing than a generic, cookie-cutter comment. 0/undefined =
     * no gate (legacy: serve the best attempt with the verdict attached).
     */
    voiceFloor?: number;
  };
  /**
   * The "ASSIGNED REGISTER FOR THIS REPLY" block (lib/register.ts), or undefined
   * when voice variety is off. Injected into the comment-drafting prompt; the DM
   * is excluded by the block's own wording.
   */
  registerBlock?: string;
  /**
   * The standalone "THIS REPLY'S ASSIGNED SHAPE" block (@noelle/runtime
   * formVariants), for a lead whose shape could NOT be rendered inside the
   * faithful style block. Mutually exclusive with registerBlock: both claim
   * authority over reply length, and two length rules in one prompt is how a
   * shaped draft gets squeezed back to the default band.
   */
  shapeBlock?: string;
  /**
   * Whether a shape was assigned at all, inline or standalone. The user prompt's
   * closing length line keys off this — it is the LAST line the model reads, so
   * a fixed char band there silently outranks any shape above it.
   */
  shapeAssigned?: boolean;
  /**
   * The "OPENING MOVE FOR THIS REPLY" block (lib/opening-move.ts), or undefined
   * when voice variety is off. Varies how the comment opens; DM excluded by the
   * block's own wording.
   */
  openingMoveBlock?: string;
  /** The gen-z "SPOKEN REGISTER" marker block, or undefined when no marker was offered. */
  genzBlock?: string;
  /** Reply bodies already sent/queued to this author (do-not-repeat memory). [] when none. */
  priorReplies?: string[];
  /** Recent reply bodies across the whole feed (global avoid-list for openers/phrasings). [] when none. */
  recentPhrasings?: string[];
  /** Explicit MCP reply request metadata. These drafts are always human-reviewed. */
  replyRequest?: ReplyRequestMeta | null;
  /**
   * Per-lead Account Feeder STYLE selection (F6), or null when style is off / no
   * selection was made. Threaded into buildDrafterSystem so the SYSTEM prompt
   * carries the STYLE block. Null → byte-identical to today.
   */
  style?: StyleForPrompt | null;
  /**
   * Active Pattern Breaker rules (noelle.pattern_rules) for this instance.
   * Injected into the drafter SYSTEM prompt so it breaks the operator's
   * over-used structures, AND passed to the verifier as dynamicBannedPatterns
   * (phrase rules hard-zero, structure rules tank voice). [] when none / off.
   */
  patternRules?: DynamicPattern[];
}

type DraftWriter = { engine: string; model: string };

/**
 * Shared post-draft VERIFIER + regenerate loop for both the substantial and
 * light paths. Off by default; when enabled, grade the drafts against the
 * grounding context and, on a failing verdict, regenerate with the critique
 * appended (up to `verify.retries`), keeping the best-scoring attempt. A
 * failed-then-best draft is still queued — the verdict rides along for the
 * human. Fail-open throughout. Returns the best drafts payload + the verdict
 * meta to attach to the outbound (null when the verifier didn't run).
 *
 * `regenerate(fixPrompt, useOpus)` re-runs the drafter with the critique
 * appended and returns the re-parsed drafts with the writer that produced them
 * (or null on a parse/skip miss), so the selected draft keeps its provenance.
 *
 * NOTE on charLimit: LinkedIn has no hard per-reply character cap like X's 250,
 * so we OMIT charLimit — the format check only flags em-dashes / choppiness, not
 * length. (Tight-reply length is a prompt-level preference, not a verifier gate.)
 */
async function runVerifyLoop<T>(args: {
  initial: T;
  initialWriter: DraftWriter;
  toDrafts: (d: T) => DraftToVerify[];
  regenerate: (fixPrompt: string, useOpus: boolean) => Promise<{ draft: T; writer: DraftWriter } | null>;
  basePrompt: string;
  ctx: VerifyContext;
  calls: VerifierCall[];
  retries: number;
  leadId: string;
  traceSource?: string;
  traceRedactions?: string[];
  log: Logger;
}): Promise<{ best: T; bestWriter: DraftWriter; meta: NonNullable<OutboundIn["verifierMeta"]> }> {
  const { initial, toDrafts, regenerate, basePrompt, ctx, calls, retries, leadId, log } = args;
  const trace = privateReviewTraceEnabled(leadId, args.traceSource) ? [] as PrivateReviewAttempt[] : null;
  const record = async (attempt: number, drafts: DraftToVerify[], verdict: DraftVerdict) => {
    if (!trace) return;
    trace.push({ attempt, drafts, verdict });
    try {
      await writePrivateReviewTrace({
        leadId,
        source: args.traceSource,
        attempts: trace,
        redactions: args.traceRedactions ?? [],
      });
    } catch {
      log.warn({ leadId }, "private review trace write failed");
    }
  };
  // Score EVERY graded dimension, including novelty (per-person repetition) and
  // diversity (feed-wide sameness). Omitting them meant a draft that failed ONLY
  // on repetition was regenerated, the rewrite fixed the repetition, and then the
  // fix was discarded because `total` had not improved — so the repetitive
  // original shipped, defeating the memory Lyra feeds the verifier. Both are 1.0
  // when there is no history, so a no-memory lead ranks exactly as before.
  const total = (v: DraftVerdict) =>
    v.scores.voice +
    v.scores.grounding +
    v.scores.relevance +
    v.scores.format +
    v.scores.novelty +
    v.scores.diversity;
  let best = initial;
  let bestWriter = args.initialWriter;
  const initialDrafts = toDrafts(initial);
  let bestVerdict = await verifyTiered(initialDrafts, ctx, calls);
  await record(0, initialDrafts, bestVerdict);
  let attempts = 0;
  while (!bestVerdict.pass && attempts < retries) {
    attempts++;
    const fix = bestVerdict.fix ?? "make the comments more specific, grounded, and on-voice";
    // Only the final genuinely rejected browser rewrite gets the stronger
    // writer and a shape override. Earlier retries and legacy leads keep their
    // existing prompts and routing.
    const useOpus = args.traceSource === "extension_observed"
      && bestVerdict.judgeOk === true
      && attempts === retries;
    const browserRepair = args.traceSource === "extension_observed"
      ? " Keep every if/may/could claim conditional as in the source; keep separate anecdotes separate from claimed causes. Use a capital letter at the start while preserving natural voice and the NO FULL STOPS rule."
      : "";
    const finalBrowserRepair = useOpus
      ? "\n\nFINAL BROWSER REPAIR — In the JSON body, write one compact comment in the operator's natural rhythm, with one grounded point. Keep the source specific by naming a concrete post detail, and leave hypothetical claims conditional. Keep separate anecdotes separate from claimed causes. The learned voice and pattern rules still apply: avoid the particular habits named in the review feedback, antithesis (X, not Y), and comma-joined run-ons. Keep the assigned shape unless the review feedback identifies a conflict. Capitalize the start; NO FULL STOPS. Do not invent the operator's personal experience. Keep accurate char_count and the same strict JSON shape."
      : "";
    const fixPrompt = `${basePrompt}\n\nREVIEW FEEDBACK — an editor rejected the previous attempt: ${fix}\nRewrite all comments (and the DM if present) to fix this.${browserRepair} Keep the exact strict JSON output shape.${finalBrowserRepair}`;
    let candidate: { draft: T; writer: DraftWriter } | null = null;
    try {
      // Spend the stronger writer only after a real rejected browser verdict
      // persists to the final retry. A judge outage never triggers escalation.
      candidate = await regenerate(fixPrompt, useOpus);
    } catch (e) {
      log.warn({ leadId, err: (e as Error).message }, "verifier regenerate failed; keeping best so far");
      break;
    }
    if (!candidate) break;
    const candidateDrafts = toDrafts(candidate.draft);
    const verdict = await verifyTiered(candidateDrafts, ctx, calls);
    await record(attempts, candidateDrafts, verdict);
    // Always adopt a PASSING candidate: the loop only runs while bestVerdict is
    // failing, so a pass is strictly better regardless of the raw sums.
    if (verdict.pass || total(verdict) > total(bestVerdict)) {
      best = candidate.draft;
      bestWriter = candidate.writer;
      bestVerdict = verdict;
    }
    if (verdict.pass) break;
  }
  log.info(
    { leadId, pass: bestVerdict.pass, attempts, scores: bestVerdict.scores },
    "draft verified",
  );
  return {
    best,
    bestWriter,
    meta: toOutboundVerifierMeta(bestVerdict, attempts),
  };
}

/**
 * SUBSTANTIAL draft: tiered angle count (T1→3 empathetic/technical/contrarian,
 * T2→2 empathetic/technical, T3→1 empathetic) plus a DM ONLY for T1.
 * Returns true when a draft was posted, false otherwise.
 */
async function draftSubstantial(args: DraftCommonArgs & { tier: "T1" | "T2" | "T3" }): Promise<boolean> {
  const { lead, tier, postText, payload, anchors, knowledgeAnchors, imageCaption, personDirective, commentDigest, brand, instance, routing, runner, postOutbound, markStatus, log, verify, registerBlock, shapeBlock, shapeAssigned, openingMoveBlock, genzBlock, priorReplies, recentPhrasings, replyRequest, style, postRegister, faithful } = args;
  const allowedAngles = TIER_ANGLES[tier];
  // The browser lane sends one reply without a human choosing among variants.
  // Its verifier verdict must belong to that exact outbound body, not to a set
  // containing companion angles or a DM that never enters the reply queue.
  const singleReply = (payload as { source?: string }).source === "extension_observed";
  const voiceReferences = voiceReferencesForReply({ anchors, style, browserReply: singleReply, faithful, sentReplies: args.voiceExemplars });
  const wantDm = !singleReply && !replyRequest && tier === "T1" && (instance.dm_autodraft_enabled ?? false);
  const repliesToReview = <T extends { angle: "empathetic" | "technical" | "contrarian"; body: string }>(drafts: T[]): T[] => {
    const selected = singleReply
      ? drafts.filter((draft) => allowedAngles.includes(draft.angle)).slice(0, 1)
      : allowedAngles.flatMap((angle) => {
          const draft = drafts.find((row) => row.angle === angle);
          return draft ? [draft] : [];
        });
    // buildOutbound applies this policy again. It is idempotent, so the judge
    // sees exactly the body that the outbound route will queue.
    return applyReplyEmojiPolicy(selected, postText);
  };

  const prompt = renderSubstantialPrompt({
    postText,
    authorName: payload.authorName ?? null,
    publicId: payload.authorPublicId ?? lead.author_handle,
    anchors: voiceReferences.writerAnchors,
    knowledgeAnchors,
    imageCaption,
    commentDigest,
    allowedAngles,
    wantDm,
    singleReply,
    registerBlock,
    shapeBlock,
    shapeAssigned,
    openingMoveBlock,
    genzBlock,
    priorReplies,
    recentPhrasings,
    ...(replyRequest?.instructions ? { operatorInstructions: replyRequest.instructions } : {}),
    // Notification leads carry the thread the sweep captured (the post it
    // started from and our own last turn). Undefined for every other lane, so
    // the cold-outbound prompt is byte-identical to before.
    conversationBlock:
      (payload as { source?: string }).source === "notification"
        ? (renderConversationBlock(
            (payload as { conversation?: ConversationBrief }).conversation,
            payload.authorName ?? lead.author_handle ?? "them",
            { fence: true },
          ) ?? undefined)
        : undefined,
  });
  const draftArgs = {
    bucket: "drafter-codex",
    routing,
    orgId: instance.org_id,
    instanceId: instance.id,
    worker: "drafter" as const,
    agentRole: "linkedin_intern" as const,
    system: buildDrafterSystem(
      instance.objective,
      personDirective,
      brand,
      style,
      postRegister,
      args.patternRules,
      faithful,
      args.voiceExemplars,
      singleReply,
    ),
    // Cache the static system prefix (base persona/rules) so it is not re-billed
    // on the initial draft OR any verify-driven regenerate. No-op until
    // NOELLE_PROMPT_CACHE_ENABLED=1 + a caching-capable backend. Rides along on
    // every `{ ...draftArgs, prompt }` spread below.
    systemCachePrefixLen: drafterSystemCachePrefixLen(brand, singleReply),
  };
  const res = await runner.draft({ ...draftArgs, prompt });
  const parsed = SubstantialOutput.safeParse(safeJsonParse(res.text));
  if (!parsed.success) {
    log.error({ leadId: lead.id, raw: res.text.slice(0, 200) }, "drafter output schema fail");
    await markStatus({ leadId: lead.id, status: "errored", meta: { error: "schema" } });
    return false;
  }
  if ("skip" in parsed.data) {
    log.info({ leadId: lead.id, skip_reason: parsed.data.skip }, "drafter skipped substantial lead");
    await markStatus({
      leadId: lead.id,
      status: replyRequest ? "errored" : "skipped",
      meta: {
        skip_reason: parsed.data.skip, engine: res.engine, model: res.model,
        ...(replyRequest ? { reply_request_key: replyRequest.requestKey, error: "reply_request_model_skip" } : {}),
      },
    });
    return false;
  }
  const prepare = (data: typeof parsed.data): typeof parsed.data => ({
    drafts: repliesToReview(data.drafts),
    ...(wantDm && data.dm ? { dm: data.dm } : {}),
  });
  let draftsData = prepare(parsed.data);
  if (!draftsData.drafts.length) {
    const noAllowedAngle = singleReply || !parsed.data.drafts.some((draft) => allowedAngles.includes(draft.angle));
    await markStatus({ leadId: lead.id, status: noAllowedAngle ? "errored" : "skipped",
      meta: noAllowedAngle ? { error: "no_in_tier_angle" } : { reason: "empty-after-emoji-policy" } });
    return false;
  }

  // Post-draft VERIFIER (+ regenerate). Off by default; grades the comments (and
  // DM) against the grounding context, regenerating with the critique on a fail.
  let selectedWriter: DraftWriter = { engine: res.engine, model: res.model };
  let verifierMeta: OutboundIn["verifierMeta"] = null;
  let replyVerifyContext: VerifyContext | null = null;
  let reviewContext: OutboundIn["drafts"][number]["reviewContext"];
  let replyVerifyCalls: VerifierCall[] = [];
  if (verify?.enabled) {
    const ctx: VerifyContext = {
      platform: "linkedin",
      postText,
      authorHandle: payload.authorPublicId ?? lead.author_handle,
      voiceAnchors: voiceReferences.reviewAnchors,
      knowledgeAnchors,
      personProfile: singleReply ? null : personDirective ?? null,
      dynamicBannedPatterns: args.patternRules,
      priorRepliesToPerson: args.priorReplies,
      // Feed-wide diversity: the same recent replies the drafter avoid-list uses,
      // now ENFORCED — a draft too alike a recent reply regenerates with a
      // different shape, so the last ~20 replies stay varied.
      recentReplies: args.recentPhrasings,
      // Let the judge grade whether the reply engages an image-driven post.
      ...(imageCaption ? { imageCaption } : {}),
      // No charLimit — LinkedIn has no hard reply cap; only flag em-dash/choppiness.
    };
    reviewContext = OutboundFactualContextSchema.parse({ version: 1, ...ctx });
    const calls = verify.makeCalls(lead.priority ?? false);
    replyVerifyContext = ctx;
    replyVerifyCalls = calls;
    const toDrafts = (d: typeof draftsData): DraftToVerify[] => {
      const rows: DraftToVerify[] = d.drafts.map((x) => ({ kind: "reply" as const, angle: x.angle, body: x.body }));
      if (wantDm && d.dm) rows.push({ kind: "dm" as const, angle: null, body: d.dm.body });
      return rows;
    };
    const { best, bestWriter, meta } = await runVerifyLoop({
      initial: draftsData,
      initialWriter: selectedWriter,
      toDrafts,
      regenerate: async (fixPrompt, useOpus) => {
        const r = await runner.draft({ ...draftArgs, routing: useOpus ? args.opusRepairRouting : routing, prompt: fixPrompt });
        const p = SubstantialOutput.safeParse(safeJsonParse(r.text));
        if (!p.success || "skip" in p.data) return null;
        const draft = prepare(p.data);
        return draft.drafts.length ? { draft, writer: { engine: r.engine, model: r.model } } : null;
      },
      basePrompt: prompt,
      ctx,
      calls,
      retries: verify.retries,
      leadId: lead.id,
      traceSource: payload.source,
      traceRedactions: [postText, payload.authorName ?? "", payload.authorPublicId ?? lead.author_handle ?? ""],
      log,
    });
    draftsData = best;
    selectedWriter = bestWriter;
    verifierMeta = meta;
  }

  // Conversation and requested replies remain visible to the human even if
  // their final angle scores below the voice floor. A low aggregate score may
  // come from a sibling reply or DM, so the floor is applied after exact-body
  // reviews, below.
  const isConversationReply = (payload as { source?: string }).source === "notification";

  // Candidates were already selected and cleaned before their set review.
  const replyRows = draftsData.drafts.map((draft) => ({
    id: randomUUID(), kind: "reply" as const, angle: draft.angle,
    body: draft.body, charCount: [...draft.body].length,
  }));

  // DM only for T1, AND only when auto-DM is enabled (0036_dm_autodraft_enabled,
  // default false). Replies-only unless the operator opts in. Fewer DMs than
  // Vega by design.
  const dmVoice = wantDm && draftsData.dm && (instance.dm_autodraft_enabled ?? false)
    ? await refineDmVoice({
        body: stripDisallowedEmoji(stripEmDashes(draftsData.dm.body)),
        regenerate: async (feedback) => {
          const result = await runner.draft({ ...draftArgs, prompt: `${prompt}\n\n${feedback}` });
          const parsedDm = SubstantialOutput.safeParse(safeJsonParse(result.text));
          return parsedDm.success && !("skip" in parsedDm.data) && parsedDm.data.dm
            ? stripDisallowedEmoji(stripEmDashes(parsedDm.data.dm.body)) : null;
        },
      }) : null;
  const dmRow =
    dmVoice?.body
    ? {
        id: randomUUID(),
        kind: "dm" as const,
        angle: null,
        body: dmVoice.body,
        charCount: [...dmVoice.body].length,
        dmVoiceCheck: { pass: true, attempts: dmVoice.attempts, reasons: dmVoice.reasons },
      }
    : null;

  // COMMITMENT GUARD (@noelle/runtime/commitment-guard). Lyra must never promise
  // anything on the operator's behalf — a call, an intro, a deadline, a yes.
  // The model is told not to (NO_COMMITMENTS_RULE in the system prompt); this is
  // the backstop for when it does anyway, because the failure is a public
  // promise the operator has to honour or walk back. The DM is dropped on its
  // own so a committing DM cannot take otherwise-good comments with it.
  const safeReplyRows = replyRows.filter((r) => !makesCommitment(r.body));
  for (const r of replyRows) {
    if (makesCommitment(r.body)) {
      log.warn(
        { reason: commitmentReason(detectCommitments(r.body)) },
        "commitment guard dropped a comment variant",
      );
    }
  }
  const safeDmRow = dmRow && makesCommitment(dmRow.body) ? null : dmRow;
  if (dmRow && !safeDmRow) {
    log.warn(
      { reason: commitmentReason(detectCommitments(dmRow.body)) },
      "commitment guard dropped the DM",
    );
  }

  const draftRows = safeDmRow ? [...safeReplyRows, safeDmRow] : safeReplyRows;
  const outbound = buildOutbound({ lead, postText, payload, anchors, drafts: draftRows, verifierMeta, style });
  if (!outbound) {
    // Every draft cleaned to empty. Skip with an ACCURATE reason rather than
    // handing an empty set to a schema that requires min(1).
    log.warn({ leadId: lead.id }, "every draft cleaned to empty; skipping the lead");
    await markStatus({ leadId: lead.id, status: "skipped", meta: { reason: "empty-after-emoji-policy" } });
    return false;
  }
  // The aggregate verdict drives regeneration; every non-browser reply gets a
  // final exact-body review so neither a sibling nor a companion DM can change
  // its own quality verdict. Browser-observed leads already review one reply.
  const outboundReplies = outbound.drafts.filter((draft) => draft.kind === "reply");
  if (reviewContext) {
    for (const draft of outboundReplies) draft.reviewContext = reviewContext;
  }
  if (replyVerifyContext && !singleReply) {
    for (const draft of outboundReplies) {
      try {
        const verdict = await verifyTiered(
          [{ kind: "reply", angle: draft.angle, body: draft.body }],
          replyVerifyContext,
          replyVerifyCalls,
        );
        draft.verifierMeta = toOutboundVerifierMeta(verdict, verifierMeta?.attempts ?? 0);
      } catch (error) {
        log.warn({ leadId: lead.id, angle: draft.angle, err: (error as Error).message }, "reply-angle verifier failed");
        draft.verifierMeta = {
          pass: false,
          scores: { voice: 0, grounding: 0, relevance: 0, format: 0 },
          reasons: ["reply-angle verifier unavailable"],
          attempts: verifierMeta?.attempts ?? 0,
          judgeOk: false,
          judgeProvider: "none",
        };
      }
    }
  }
  const voiceFloor = verify?.voiceFloor;
  if (voiceFloor && verifierMeta) {
    const weakReplies = outboundReplies.filter((draft) => {
      const review = draft.verifierMeta ?? verifierMeta;
      return review.judgeOk === true && review.scores.voice < voiceFloor;
    });
    if (weakReplies.length && (isConversationReply || replyRequest)) {
      log.info({ leadId: lead.id, angles: weakReplies.map((draft) => draft.angle) },
        "conversation reply below voice floor — serving for human review");
    } else if (weakReplies.length) {
      const weakIds = new Set(weakReplies.map((draft) => draft.id));
      outbound.drafts = outbound.drafts.filter((draft) => draft.kind !== "reply" || !weakIds.has(draft.id));
      log.info({ leadId: lead.id, angles: weakReplies.map((draft) => draft.angle) },
        "removed reply angles below voice floor");
      if (!outbound.drafts.some((draft) => draft.kind === "reply")) {
        const lowestVoice = Math.min(...weakReplies.map((draft) =>
          (draft.verifierMeta ?? verifierMeta).scores.voice));
        await markStatus({
          leadId: lead.id,
          status: "skipped",
          meta: { skip_reason: "low-voice", voice: lowestVoice, model: selectedWriter.model },
        });
        return false;
      }
    }
  }
  await postOutbound(withReplyRequestOwner(outbound, replyRequest, instance));
  await markStatus({
    leadId: lead.id, status: "drafted",
    meta: { engine: selectedWriter.engine, model: selectedWriter.model, tier, reply_kind: "substantial", ...(replyRequest ? { reply_request_key: replyRequest.requestKey } : {}) },
  });
  return true;
}

/**
 * LIGHT draft: ONE short, warm, specific supportive comment (kind='reply'). No
 * DM, no pitch. Returns true when a draft was posted.
 */
async function draftLight(args: DraftCommonArgs): Promise<boolean> {
  const { lead, postText, payload, anchors, knowledgeAnchors, imageCaption, personDirective, commentDigest, brand, instance, routing, runner, postOutbound, markStatus, log, verify, registerBlock, shapeBlock, shapeAssigned, openingMoveBlock, genzBlock, priorReplies, recentPhrasings, replyRequest, style, postRegister, faithful } = args;
  const browserReply = payload.source === "extension_observed";
  const voiceReferences = voiceReferencesForReply({ anchors, style, browserReply, faithful, sentReplies: args.voiceExemplars });
  const prompt = renderLightPrompt({
    postText,
    authorName: payload.authorName ?? null,
    publicId: payload.authorPublicId ?? lead.author_handle,
    voiceAnchors: browserReply ? voiceReferences.writerAnchors : [],
    knowledgeAnchors,
    imageCaption,
    commentDigest,
    registerBlock,
    shapeBlock,
    shapeAssigned,
    openingMoveBlock,
    genzBlock,
    priorReplies,
    recentPhrasings,
    ...(replyRequest?.instructions ? { operatorInstructions: replyRequest.instructions } : {}),
    // Notification leads carry the thread the sweep captured (the post it
    // started from and our own last turn). Undefined for every other lane, so
    // the cold-outbound prompt is byte-identical to before.
    conversationBlock:
      (payload as { source?: string }).source === "notification"
        ? (renderConversationBlock(
            (payload as { conversation?: ConversationBrief }).conversation,
            payload.authorName ?? lead.author_handle ?? "them",
            { fence: true },
          ) ?? undefined)
        : undefined,
  });
  const draftArgs = {
    bucket: "drafter-codex",
    routing,
    orgId: instance.org_id,
    instanceId: instance.id,
    worker: "drafter" as const,
    agentRole: "linkedin_intern" as const,
    system: buildLightDrafterSystem(instance.objective, personDirective, brand, style, postRegister, args.patternRules, faithful, browserReply, args.voiceExemplars),
  };
  const res = await runner.draft({ ...draftArgs, prompt });
  const parsed = LightOutput.safeParse(safeJsonParse(res.text));
  if (!parsed.success) {
    log.error({ leadId: lead.id, raw: res.text.slice(0, 200) }, "light drafter output schema fail");
    await markStatus({ leadId: lead.id, status: "errored", meta: { error: "schema" } });
    return false;
  }
  if ("skip" in parsed.data) {
    log.info({ leadId: lead.id, skip_reason: parsed.data.skip }, "light drafter skipped lead");
    await markStatus({
      leadId: lead.id,
      status: replyRequest ? "errored" : "skipped",
      meta: {
        skip_reason: parsed.data.skip, engine: res.engine, model: res.model,
        ...(replyRequest ? { reply_request_key: replyRequest.requestKey, error: "reply_request_model_skip" } : {}),
      },
    });
    return false;
  }

  // Review the single normalized reply that will reach outbound.
  const prepare = (data: typeof parsed.data): typeof parsed.data => ({
    drafts: applyReplyEmojiPolicy(data.drafts.slice(0, 1).map((draft) => ({
      ...draft, angle: draft.angle === "supportive" ? "empathetic" as const : draft.angle,
    })), postText),
  });
  let draftsData = prepare(parsed.data);
  if (!draftsData.drafts.length) {
    await markStatus({ leadId: lead.id, status: "skipped", meta: { reason: "empty-after-emoji-policy" } });
    return false;
  }
  let selectedWriter: DraftWriter = { engine: res.engine, model: res.model };
  let verifierMeta: OutboundIn["verifierMeta"] = null;
  let reviewContext: OutboundIn["drafts"][number]["reviewContext"];
  if (verify?.enabled) {
    const ctx: VerifyContext = {
      platform: "linkedin",
      postText,
      authorHandle: payload.authorPublicId ?? lead.author_handle,
      voiceAnchors: voiceReferences.reviewAnchors,
      knowledgeAnchors,
      personProfile: browserReply ? null : personDirective ?? null,
      // No charLimit — see runVerifyLoop note.
      // LIGHT replies ARE a warm congrats on a win — don't hard-zero the
      // celebration closers ("congrats on the launch", "love this"); they're the
      // intended content here, not tacked-on slop.
      allowCelebration: true,
      dynamicBannedPatterns: args.patternRules,
      priorRepliesToPerson: args.priorReplies,
      // Feed-wide diversity (see substantial path) — keep light replies varied too.
      recentReplies: args.recentPhrasings,
      // Let the judge grade whether the reply engages an image-driven post.
      ...(imageCaption ? { imageCaption } : {}),
    };
    reviewContext = OutboundFactualContextSchema.parse({ version: 1, ...ctx });
    const calls = verify.makeCalls(lead.priority ?? false);
    const toDrafts = (d: typeof draftsData): DraftToVerify[] =>
      d.drafts.map((x) => ({ kind: "reply" as const, angle: x.angle, body: x.body }));
    const { best, bestWriter, meta } = await runVerifyLoop({
      initial: draftsData,
      initialWriter: selectedWriter,
      toDrafts,
      regenerate: async (fixPrompt, useOpus) => {
        const r = await runner.draft({ ...draftArgs, routing: useOpus ? args.opusRepairRouting : routing, prompt: fixPrompt });
        const p = LightOutput.safeParse(safeJsonParse(r.text));
        if (!p.success || "skip" in p.data) return null;
        const draft = prepare(p.data);
        return draft.drafts.length ? { draft, writer: { engine: r.engine, model: r.model } } : null;
      },
      basePrompt: prompt,
      ctx,
      calls,
      retries: verify.retries,
      leadId: lead.id,
      traceSource: payload.source,
      traceRedactions: [postText, payload.authorName ?? "", payload.authorPublicId ?? lead.author_handle ?? ""],
      log,
    });
    draftsData = best;
    selectedWriter = bestWriter;
    verifierMeta = meta;
  }

  // Voice gate (same as substantial): drop a still-generic light comment rather
  // than serve it. A weak "love this, congrats" that fails the voice floor is
  // exactly the slop the operator doesn't want.
  if (replyRequest && verifierMeta && verify?.voiceFloor && verifierMeta.scores.voice < verify.voiceFloor) {
    log.info(
      { leadId: lead.id, voice: verifierMeta.scores.voice, floor: verify.voiceFloor },
      "requested light reply below the voice floor — serving it for human review",
    );
  } else if (verifierMeta && verify?.voiceFloor && verifierMeta.scores.voice < verify.voiceFloor) {
    log.info(
      { leadId: lead.id, voice: verifierMeta.scores.voice, floor: verify.voiceFloor },
      "light draft below voice floor; skipping instead of serving a generic comment",
    );
    await markStatus({
      leadId: lead.id,
      status: "skipped",
      meta: { skip_reason: "low-voice", voice: verifierMeta.scores.voice, model: selectedWriter.model },
    });
    return false;
  }

  // Exactly one normalized comment was selected before review.
  const first = draftsData.drafts[0]!;
  if (makesCommitment(first.body)) {
    const reason = commitmentReason(detectCommitments(first.body)) || "commitment-guard";
    log.warn({ leadId: lead.id, reason }, "commitment guard dropped a light reply");
    await markStatus({ leadId: lead.id, status: "skipped", meta: { skip_reason: reason } });
    return false;
  }
  const angle = first.angle;
  const replyRow = {
    id: randomUUID(),
    kind: "reply" as const,
    angle: angle as "empathetic" | "technical" | "contrarian" | null,
    body: first.body,
    charCount: first.char_count ?? [...first.body].length,
  };
  const outbound = buildOutbound({ lead, postText, payload, anchors, drafts: [replyRow], verifierMeta, style });
  if (!outbound) {
    // Every draft cleaned to empty. Skip with an ACCURATE reason rather than
    // handing an empty set to a schema that requires min(1).
    log.warn({ leadId: lead.id }, "every draft cleaned to empty; skipping the lead");
    await markStatus({ leadId: lead.id, status: "skipped", meta: { reason: "empty-after-emoji-policy" } });
    return false;
  }
  if (reviewContext) {
    for (const draft of outbound.drafts) draft.reviewContext = reviewContext;
  }
  await postOutbound(withReplyRequestOwner(outbound, replyRequest, instance));
  await markStatus({
    leadId: lead.id, status: "drafted",
    meta: { engine: selectedWriter.engine, model: selectedWriter.model, reply_kind: "light", ...(replyRequest ? { reply_request_key: replyRequest.requestKey } : {}) },
  });
  return true;
}

/**
 * Build the OutboundIn payload. CRITICAL INVARIANT: there is NO `autoSend` field
 * — Lyra is draft-only and never auto-sends. The field is omitted entirely.
 */
function buildOutbound(args: {
  lead: LeadRow;
  postText: string;
  payload: { url?: string };
  anchors: Array<{ snippet: string; score: number }>;
  drafts: Array<{ id: string; kind: "reply" | "dm"; angle: "empathetic" | "technical" | "contrarian" | null; body: string; charCount: number }>;
  /** Post-draft verifier verdict (null when the verifier didn't run). */
  verifierMeta?: OutboundIn["verifierMeta"];
  /**
   * The style exemplars the selector chose for this lead (Account Feeder). Used
   * to derive the style-source blend shown on the approval card. Omitted/null on
   * the DM path and when style injection is off ⇒ no badge (base voice only).
   */
  style?: StyleForPrompt | null;
}): OutboundIn | null {
  const { lead, postText, payload, anchors, drafts, verifierMeta, style } = args;
  if (lead.payload.source === "extension_observed" &&
      !hasCanonicalObservedIdentity(lead, lead.payload)) return null;
  // Hard emoji backstop: strip any emoji outside the {💀 😭 😛} allowlist the
  // prompt asks for, and recompute char_count off the cleaned body so the inbox
  // count matches what ships. The model can't be trusted to self-restrict.
  //
  // The postText gate ("no emoji at all when the post used none") is a REPLY
  // rule and is passed only for reply rows. This function is the shared path
  // for replies AND DMs, so applying it to everything would have silently
  // extended a reply-only rule to Lyra's DMs — which the prompts explicitly
  // exempt, and which the X drafter deliberately keeps post-agnostic. A DM is
  // not answering a post, so there is nothing for it to match.
  const cleanedDrafts = applyReplyEmojiPolicy(
    drafts,
    postText,
    (d) => d.kind === "reply",
  ).map((d) => ({ ...d, charCount: [...d.body].length }));
  // NULL, not an empty drafts array: OutboundInSchema requires min(1), so an
  // empty set throws in postOutbound. Callers skip on null with their own
  // accurate reason instead.
  if (cleanedDrafts.length === 0) return null;
  return {
    leadId: lead.external_id,
    batchNumber: null,
    platform: "linkedin",
    authorHandle: lead.author_handle,
    authorId: lead.author_id ?? "0",
    authorFollowers: null,
    allowsDms: null,
    originalPostId: lead.external_id,
    originalPostText: postText,
    originalPostUrl:
      payload.url ?? `https://www.linkedin.com/feed/update/urn:li:activity:${lead.external_id}/`,
    postedAt: readSourceTimestamp(lead.payload.posted_at),
    matchedTrigger: null,
    drafts: cleanedDrafts,
    tier: lead.tier ?? null,
    postKind: lead.classifier_label,
    anchors: anchors.slice(0, 5).map((a) => ({ snippet: a.snippet, score: a.score })),
    // Post-draft verifier verdict (null when off). The api-vm route persists it
    // onto public reply payloads. DMs carry their own dmVoiceCheck instead.
    verifierMeta: verifierMeta ?? null,
    // Account-Feeder style-source blend (null when style injection is off / no
    // exemplars). The api-vm route persists it onto each draft's payload as
    // style_source so the approval card can show a "Style: …" badge.
    styleSource: buildStyleSource(style),
    // NO autoSend block — Lyra never auto-sends. The field is intentionally
    // omitted from the payload entirely.
  };
}

function withReplyRequestOwner(
  outbound: OutboundIn,
  replyRequest: ReplyRequestMeta | null | undefined,
  instance: ActiveInstance,
): OutboundIn {
  if (!replyRequest) return outbound;
  return {
    ...outbound,
    owner: { orgId: instance.org_id, agentInstanceId: instance.id },
    replyRequestKey: replyRequest.requestKey,
    humanReviewRequired: replyRequest.humanReviewRequired,
  };
}


/**
 * Re-set a deferred lead back to 'classified' (it was claimed as 'drafting' by
 * the RPC) so a later tick re-claims and drafts it. Stamps the defer reason into
 * payload.classifier so it's legible in the dashboard.
 * No-op when sql is absent (tests).
 */
async function deferLeadToClassified(args: {
  sql?: Sql;
  leadId: string;
  replyKind: "substantial" | "light";
  /** Why it was deferred. 'daily_cap' (kind's quota spent) or 'budget' (org spend cap). */
  reason?: "daily_cap" | "budget";
}): Promise<void> {
  if (!args.sql) return;
  const stamp: JSONValue =
    args.reason === "budget"
      ? ({ budget_deferred: args.replyKind } as JSONValue)
      : ({ daily_cap_deferred: args.replyKind } as JSONValue);
  await args.sql`
    update noelle.leads
    set status = 'classified',
        payload = payload || ${args.sql.json(stamp)}::jsonb,
        updated_at = now()
    where id = ${args.leadId}
  `;
}

/**
 * Browser observations and older Apify leads use different engagement field
 * names. Resolve them before model tiering and comment-context gating.
 */
function leadEngagement(payload: {
  reactionCount?: number | null; commentCount?: number | null;
  reactions?: number | null; comments?: number | null;
}): { likes: number | null | undefined; comments: number | null | undefined } {
  return {
    likes: payload.reactionCount ?? payload.reactions,
    comments: payload.commentCount ?? payload.comments,
  };
}

/**
 * useOpus = likes > likesThreshold || (comments > commentsThreshold && !commentBait).
 * The comments trigger is suppressed for engagement-bait posts. Missing or
 * non-finite engagement counts are treated as zero.
 */
export function decideOpus(args: {
  likes: number | null | undefined;
  comments: number | null | undefined;
  commentBait: boolean;
  likesThreshold: number;
  commentsThreshold: number;
}): { useOpus: boolean; likes: number; comments: number; commentBait: boolean } {
  const likes = Number.isFinite(args.likes) ? (args.likes as number) : 0;
  const comments = Number.isFinite(args.comments) ? (args.comments as number) : 0;
  const useOpus =
    likes > args.likesThreshold ||
    (comments > args.commentsThreshold && !args.commentBait);
  return { useOpus, likes, comments, commentBait: args.commentBait };
}

/**
 * Fetch + digest the existing comments on a post for the drafter prompt. Gated:
 * no fetcher, no URL, or a known comment count below `minCount` → returns "" (no
 * spend). Fail-open on an Apify error. The caller meters each paid attempt,
 * including failed reads and empty results.
 */
async function fetchCommentDigest(args: {
  lead: LeadRow;
  payload: { url?: string; comments?: number | null };
  fetchPostComments?: (postUrl: string) => Promise<LinkedInComment[]>;
  maxComments: number;
  minCount: number;
  log: Logger;
}): Promise<string> {
  const { lead, payload, fetchPostComments, maxComments, minCount, log } = args;
  const totalCount = Number.isFinite(payload.comments) ? (payload.comments as number) : 0;
  const url = payload.url;
  if (!fetchPostComments || !url || totalCount < minCount) return "";

  let comments: LinkedInComment[];
  try {
    comments = await fetchPostComments(url);
  } catch (err) {
    log.warn(
      { leadId: lead.id, err: (err as Error).message },
      "comment fetch failed; drafting without comment context",
    );
    return "";
  }
  if (comments.length === 0) return "";

  return renderCommentDigest(
    comments.map((c) => ({
      text: c.text,
      authorName: c.authorName,
      authorHeadline: c.authorHeadline,
      reactions: c.reactions,
    })),
    Math.max(totalCount, comments.length),
    maxComments < 12 ? maxComments : 12,
  );
}

function buildPersonDirective(
  payload: { authorName?: string | null; authorHeadline?: string | null },
  profile: WatchlistProfileRow | undefined,
  objective: WatchlistObjectiveEntry | undefined,
): string | null {
  const lines: string[] = [];
  if (payload.authorName) lines.push(`Name: ${payload.authorName}`);
  if (payload.authorHeadline) lines.push(`Headline: ${payload.authorHeadline}`);
  if (profile?.summary) lines.push(`Who they are: ${profile.summary}`);
  if (profile?.topics?.length) lines.push(`Topics they post about: ${profile.topics.join(", ")}`);
  if (profile?.tone) lines.push(`How they write: ${profile.tone}`);
  if (profile?.engagementNotes) lines.push(`How to engage them so it lands: ${profile.engagementNotes}`);
  if (objective?.objective) lines.push(`Operator's goal for this person: ${objective.objective}`);
  return lines.length > 0 ? lines.join("\n") : null;
}

/**
 * The "Product knowledge" block injected into the drafter prompt from the second
 * (scoped) knowledge retrieval pass. Empty array → no block (byte-identical to
 * today). Mirrors the X intern's renderPrompt knowledge wording.
 */
function knowledgeBlock(knowledgeAnchors: string[]): string[] {
  if (!knowledgeAnchors.length) return [];
  return [
    "",
    "Product knowledge from the operator's vault (the ONLY facts you may assert about the product/offer — do not invent capabilities, pricing, or claims beyond these; if none fit, write a peer comment with no pitch):",
    knowledgeAnchors.map((a, i) => `[${i + 1}] ${a}`).join("\n"),
  ];
}

/** The vision-caption line, or [] when there's no caption. */
function imageBlock(imageCaption: string): string[] {
  return imageCaption
    ? [
        "",
        `THE POST'S IMAGE SHOWS: ${imageCaption}`,
        "The image is part of what they posted — if it's central to the point (a chart, screenshot, photo, slide, result), your reply SHOULD engage with the specific thing it shows, not just the text. Reference what's actually in it (the number, the detail, the moment). If the image is incidental, don't force it. Never a generic \"love the visual / great graphic\".",
      ]
    : [];
}

/**
 * The "you already said this to this person" block, or [] when there's no
 * history. Lists the reply bodies Lyra already sent/queued to THIS connection so
 * the model says something new instead of repeating its own take. Each is
 * truncated to keep the prompt bounded.
 */
function priorRepliesBlock(priorReplies: string[] | undefined): string[] {
  if (!priorReplies || priorReplies.length === 0) return [];
  const lines = priorReplies
    .slice(0, 5)
    .map((b, i) => `[${i + 1}] ${b.length > 240 ? `${b.slice(0, 237)}…` : b}`);
  return [
    "",
    "COMMENTS YOU ALREADY SENT/QUEUED TO THIS PERSON (do NOT repeat these takes, openers, or phrasings — they've already heard them; bring a genuinely different angle or stay quiet on what you already covered):",
    ...lines,
  ];
}

/**
 * The global "phrasings you've reached for lately, across the whole feed" block,
 * or [] when there's no history. These are Lyra's most recent replies to ANY
 * author — the point is to vary openers and stock phrasings feed-wide, so the
 * comments stop reading like the same template. Truncated to keep the prompt
 * bounded.
 */
function recentPhrasingsBlock(recentPhrasings: string[] | undefined): string[] {
  if (!recentPhrasings || recentPhrasings.length === 0) return [];
  const lines = recentPhrasings
    .slice(0, 20)
    .map((b, i) => `[${i + 1}] ${b.length > 160 ? `${b.slice(0, 157)}…` : b}`);
  return [
    "",
    "YOUR LAST REPLIES ACROSS THE FEED (these should be nothing alike — make THIS one clearly different: vary the opener, the length, the rhythm, the closer, and the words you reach for, so your comments never read like one template):",
    ...lines,
  ];
}

function renderSubstantialPrompt(args: {
  postText: string;
  authorName: string | null;
  publicId: string | null;
  anchors: string[];
  knowledgeAnchors: string[];
  imageCaption: string;
  commentDigest: string;
  allowedAngles: Array<"empathetic" | "technical" | "contrarian">;
  wantDm: boolean;
  singleReply?: boolean;
  /**
   * The "ASSIGNED REGISTER FOR THIS REPLY" block (lib/register.ts), or undefined
   * when voice variety is off. Injected between the post and the voice anchors so
   * the model reads it as a directive on the comment register. The DM is excluded
   * by the block's own wording.
   */
  registerBlock?: string;
  /**
   * The standalone "THIS REPLY'S ASSIGNED SHAPE" block, rendered in the register
   * slot (they are mutually exclusive — both claim reply length).
   */
  shapeBlock?: string;
  /**
   * True when a shape was assigned at all, inline in the STYLE block or as
   * `shapeBlock`. Only this flag can neutralise the closing length line below.
   */
  shapeAssigned?: boolean;
  /** The "OPENING MOVE FOR THIS REPLY" block (lib/opening-move.ts), or undefined when variety is off. */
  openingMoveBlock?: string;
  /** The gen-z "SPOKEN REGISTER" marker block, or undefined when no marker was offered. */
  genzBlock?: string;
  /** Reply bodies already sent/queued to this person (do-not-repeat memory). */
  priorReplies?: string[];
  /** Recent reply bodies across the whole feed (global avoid-list). */
  recentPhrasings?: string[];
  /**
   * The CONVERSATION block for a notification lead — the post this exchange
   * started from, and the last thing WE said. Without it the drafter has no
   * idea it is mid-conversation and writes an opening remark into a two-person
   * exchange.
   */
  /** Operator guidance attached to an explicit MCP reply request. */
  operatorInstructions?: string;
  conversationBlock?: string | undefined;
}): string {
  const who = args.authorName ?? (args.publicId ? `@${args.publicId}` : "a watchlist person");
  const angleList = args.allowedAngles.join(", ");
  const draftsShape = args.singleReply
    ? '{"angle":"empathetic","body":"…","char_count":N}'
    : args.allowedAngles
        .map((a) => `{"angle":"${a}","body":"…","char_count":N}`)
        .join(",");
  const dmShape = args.wantDm ? ',"dm":{"body":"…","char_count":N}' : "";
  return [
    // First, so the model reads "this is a thread you are already in" BEFORE it
    // reads the post — otherwise it frames the whole thing as a cold comment.
    ...(args.conversationBlock ? [args.conversationBlock, ""] : []),
    `LinkedIn post by ${who}:`,
    args.postText,
    ...imageBlock(args.imageCaption),
    ...(args.commentDigest ? ["", args.commentDigest] : []),
    ...priorRepliesBlock(args.priorReplies),
    ...recentPhrasingsBlock(args.recentPhrasings),
    ...(args.registerBlock
      ? ["", args.registerBlock]
      : args.shapeBlock
        ? ["", args.shapeBlock]
        : []),
    ...(args.openingMoveBlock ? ["", args.openingMoveBlock] : []),
    ...(args.genzBlock ? ["", args.genzBlock] : []),
    ...(args.operatorInstructions ? ["", "OPERATOR REQUEST FOR THIS REPLY — follow this guidance for this draft only:", args.operatorInstructions] : []),
    "",
    "Voice anchors from the operator's knowledge base (use these to ground tone + specific opinions, not as topics to force):",
    args.anchors.length
      ? args.anchors.map((a, i) => `[${i + 1}] ${a}`).join("\n")
      : "(none — draft from general voice)",
    ...knowledgeBlock(args.knowledgeAnchors),
    "",
    args.singleReply
      ? `This lead has already been judged worth a substantial reply by the upstream gate. Draft exactly one comment, choosing the strongest angle for this post from: ${angleList}.${args.allowedAngles.length > 1 ? " The example JSON uses empathetic; choose another listed angle when that is stronger." : ""} Do NOT draft a DM or output a skip.`
      : `This lead has already been judged worth a substantial reply by the upstream gate. Draft exactly ${args.allowedAngles.length} comment${args.allowedAngles.length > 1 ? "s" : ""} (angles: ${angleList})${args.wantDm ? " AND one DM" : " (no DM for this tier)"}. Do NOT output a skip — the gate already decided.`,
    "",
    "OUTPUT FORMAT — STRICT JSON, NO PREAMBLE, NO MARKDOWN FENCES:",
    "The very first character of your response MUST be `{` and the last `}`.",
    `  {"drafts":[${draftsShape}]${dmShape}}`,
    // SHAPE-AWARE. This is the LAST line of the user message, below the shape
    // block, so the shape's own "overrides the rules above" cannot reach it. A
    // fixed 90-180/220 band here competes with every shape whose band falls
    // outside it — which was most of the rotation, and is why Lyra's feed
    // measured 181 +/- 44 chars while Vega's spread 131 +/- 58.
    args.shapeAssigned || args.registerBlock
      ? "Each comment's length and sentence count are EXACTLY what the ASSIGNED SHAPE / ASSIGNED REGISTER block above says — that block REPLACES the default ~90-180 target and the ~220 ceiling, and may legitimately be three words or a ~320-char run-on. Do not pad a short one to feel substantial and do not compress a long one. One thread, not a summary of the post."
      : "Each comment is ONE sharp sentence (a short second only if it earns a beat): aim ~90-180 chars, ~220 hard ceiling. One thread, not a summary of the post.",
    args.singleReply
      ? "Output exactly one comment with its chosen angle. Do NOT include a `dm`."
      : args.wantDm
      ? "Output the comment drafts (one per listed angle, in that order) plus exactly one `dm` (the longer cold-outreach message, ~400-700 chars, fragmented with \\n between chunks)."
      : "Output the comment drafts (one per listed angle, in that order). Do NOT include a `dm` for this tier.",
  ].join("\n");
}

function renderLightPrompt(args: {
  postText: string;
  authorName: string | null;
  publicId: string | null;
  voiceAnchors?: string[];
  knowledgeAnchors: string[];
  imageCaption: string;
  commentDigest: string;
  /**
   * The "ASSIGNED REGISTER FOR THIS REPLY" block (lib/register.ts), or undefined
   * when voice variety is off. A light post is a win/launch — HYPE lands here.
   */
  registerBlock?: string;
  /**
   * The standalone "THIS REPLY'S ASSIGNED SHAPE" block, rendered in the register
   * slot (they are mutually exclusive — both claim reply length).
   */
  shapeBlock?: string;
  /**
   * True when a shape was assigned at all, inline in the STYLE block or as
   * `shapeBlock`. Only this flag can neutralise the closing length line below.
   */
  shapeAssigned?: boolean;
  /** The "OPENING MOVE FOR THIS REPLY" block (lib/opening-move.ts), or undefined when variety is off. */
  openingMoveBlock?: string;
  /** The gen-z "SPOKEN REGISTER" marker block, or undefined when no marker was offered. */
  genzBlock?: string;
  /** Reply bodies already sent/queued to this person (do-not-repeat memory). */
  priorReplies?: string[];
  /** Recent reply bodies across the whole feed (global avoid-list). */
  recentPhrasings?: string[];
  /**
   * The CONVERSATION block for a notification lead — the post this exchange
   * started from, and the last thing WE said. Without it the drafter has no
   * idea it is mid-conversation and writes an opening remark into a two-person
   * exchange.
   */
  /** Operator guidance attached to an explicit MCP reply request. */
  operatorInstructions?: string;
  conversationBlock?: string | undefined;
}): string {
  const who = args.authorName ?? (args.publicId ? `@${args.publicId}` : "a watchlist person");
  return [
    // First, so the model reads "this is a thread you are already in" BEFORE it
    // reads the post — otherwise it frames the whole thing as a cold comment.
    ...(args.conversationBlock ? [args.conversationBlock, ""] : []),
    `LinkedIn post by ${who}:`,
    args.postText,
    ...imageBlock(args.imageCaption),
    ...(args.commentDigest ? ["", args.commentDigest] : []),
    ...(args.voiceAnchors?.length
      ? ["", "CURATED OPERATOR VOICE ANCHORS (tone and form only; do not use these as facts about this post or as a personal story):", ...args.voiceAnchors.slice(0, 4).map((anchor, i) => `[${i + 1}] ${anchor.slice(0, 320)}`)]
      : []),
    ...knowledgeBlock(args.knowledgeAnchors),
    ...priorRepliesBlock(args.priorReplies),
    ...recentPhrasingsBlock(args.recentPhrasings),
    ...(args.registerBlock
      ? ["", args.registerBlock]
      : args.shapeBlock
        ? ["", args.shapeBlock]
        : []),
    ...(args.openingMoveBlock ? ["", args.openingMoveBlock] : []),
    ...(args.genzBlock ? ["", args.genzBlock] : []),
    ...(args.operatorInstructions ? ["", "OPERATOR REQUEST FOR THIS REPLY — follow this guidance for this draft only:", args.operatorInstructions] : []),
    "",
    // "short" is a LENGTH word sitting below the shape block, so it needs the
    // same carve-out the trailing sentence-count line already got. Newly
    // load-bearing: light leads are almost always celebration, which used to
    // mean no shape at all — now half of them take RUN_ON or SELF_STORY
    // (~150-260 chars) and would be arguing with a later "short".
    args.shapeAssigned
      ? "This is a win / launch / milestone post. Write ONE warm, specific congratulatory comment in the operator's voice, at exactly the length the ASSIGNED SHAPE block above asks for. No pitch, no link, no DM."
      : "This is a win / launch / milestone post. Write ONE short, warm, specific congratulatory comment in the operator's voice. No pitch, no link, no DM.",
    "",
    "OUTPUT FORMAT — STRICT JSON, NO PREAMBLE, NO MARKDOWN FENCES:",
    "The very first character of your response MUST be `{` and the last `}`.",
    '  {"drafts":[{"angle":"empathetic","body":"…","char_count":N}]}',
    // Shape-aware for the same reason as the substantial path: a trailing
    // "1-2 sentences" outranks an assigned shape that asked for one word.
    args.shapeAssigned || args.registerBlock
      ? "Exactly ONE draft. Its length and sentence count are EXACTLY what the ASSIGNED SHAPE / ASSIGNED REGISTER block above says, which replaces the default 1-2 sentences. No `dm`."
      : "Exactly ONE draft. 1-2 sentences. No `dm`.",
  ].join("\n");
}

function safeJsonParse(s: string): unknown {
  try { return normalizeSkipShape(JSON.parse(s)); } catch { /* fall through */ }
  try {
    const stripped = s.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "");
    return normalizeSkipShape(JSON.parse(stripped));
  } catch { /* fall through */ }
  const firstBrace = s.indexOf("{");
  const lastBrace = s.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    try { return normalizeSkipShape(JSON.parse(s.slice(firstBrace, lastBrace + 1))); }
    catch { /* fall through */ }
  }
  const trimmed = s.trim();
  const skipMatch = trimmed.match(/^SKIP:\s*(.+)/is);
  if (skipMatch) return { skip: skipMatch[1]!.trim() };
  if (looksLikeProseSkip(trimmed)) {
    return { skip: trimmed.slice(0, 480) };
  }
  return null;
}

const PROSE_SKIP_MARKERS = [
  "no overlap",
  "no fit",
  "not a fit",
  "recommending skip",
  "recommend skipping",
  "skip this lead",
];

function looksLikeProseSkip(s: string): boolean {
  const lower = s.toLowerCase();
  return PROSE_SKIP_MARKERS.some((m) => lower.includes(m));
}

function normalizeSkipShape(parsed: unknown): unknown {
  if (
    parsed &&
    typeof parsed === "object" &&
    "drafts" in parsed &&
    Array.isArray((parsed as { drafts: unknown }).drafts)
  ) {
    const drafts = (parsed as { drafts: Array<{ angle?: unknown; body?: unknown }> }).drafts;
    const allSkip =
      drafts.length > 0 &&
      drafts.every((d) => typeof d?.angle === "string" && /^skip$/i.test(d.angle));
    if (allSkip) {
      const body = drafts[0]?.body;
      const reason = typeof body === "string" ? body : "skipped by model";
      return { skip: reason };
    }
  }
  return parsed;
}

/**
 * On-demand DM generation pass (Lyra). Given leads the operator flagged via the
 * dashboard "Generate DM" action (claimed by claimDmRequestLeads, which clears
 * the flag), draft a single DM for each — reusing the substantial prompt + voice
 * (the T1 angle set + wantDm) — and queue ONLY the DM (the comment was already
 * handled). Independent of the auto-DM toggle + the reply lane, so it runs
 * whenever the drafter ticks. Lyra is draft-only — buildOutbound omits autoSend.
 */
export async function runDmRequestTick(
  args: Pick<
    RunDrafterTickArgs,
    "log" | "instance" | "claimedLeads" | "runner" | "postOutbound" | "sql"
  >,
): Promise<number> {
  const { log, instance, claimedLeads, runner, postOutbound, sql } = args;
  if (claimedLeads.length === 0) return 0;
  const routing = linkedinInternRouting(instance);
  let drafted = 0;
  for (const lead of claimedLeads) {
    const payload = lead.payload as {
      text?: string;
      url?: string;
      authorName?: string | null;
      authorPublicId?: string | null;
      authorHeadline?: string | null;
    };
    const postText = payload.text ?? "";
    if (!postText) continue;
    try {
      // Where in the relationship are we? The rung is chosen by how many DMs the
      // operator has already SENT this person: 0 → Open, 1 → Deepen, 2 → Bridge,
      // 3+ → Invite (the only rung that may propose a call). Start small, progress.
      const authorHandle = payload.authorPublicId ?? lead.author_handle;
      const sentCount = sql
        ? await countSentDmsToAuthor(sql, {
            agentInstanceId: instance.id,
            authorHandle,
            authorId: lead.author_id,
          })
        : 0;
      const rung = pickRung(sentCount);
      const priorDmBodies = sql
        ? await getRecentDmsToAuthor(sql, {
            agentInstanceId: instance.id,
            authorHandle,
            authorId: lead.author_id,
            excludeLeadId: lead.id,
            limit: 4,
          })
        : [];

      const draftArgs = {
        bucket: "drafter-codex",
        routing,
        orgId: instance.org_id,
        instanceId: instance.id,
        worker: "drafter",
        agentRole: "linkedin_intern",
        system: buildLadderDmSystem(rung),
        prompt: renderLadderDmPrompt({
          rung,
          postText,
          person: {
            name: payload.authorName ?? null,
            publicId: authorHandle,
            headline: payload.authorHeadline ?? null,
          },
          priorDmBodies,
        }),
      } satisfies Parameters<CodexRunner["draft"]>[0];
      const res = await runner.draft(draftArgs);
      const parsed = IntroDmOutput.safeParse(safeJsonParse(res.text));
      if (!parsed.success) {
        log.warn(
          { leadId: lead.id, rung: rung.index, raw: res.text.slice(0, 200) },
          "dm-ladder: drafter output schema fail; skipping",
        );
        continue;
      }
      // Hard voice backstop: strip em dashes (buildOutbound strips disallowed
      // emoji + recomputes char_count, but not em dashes). The rung is recorded in
      // the log line below; the visible per-draft badge is a follow-up (needs the
      // OutboundIn → api-vm payload plumbing).
      const reviewed = await refineDmVoice({
        body: stripDisallowedEmoji(stripEmDashes(parsed.data.body)),
        charLimit: 700,
        regenerate: async (feedback) => {
          const result = await runner.draft({ ...draftArgs, prompt: `${draftArgs.prompt}\n\n${feedback}` });
          const revised = IntroDmOutput.safeParse(safeJsonParse(result.text));
          return revised.success ? stripDisallowedEmoji(stripEmDashes(revised.data.body)) : null;
        },
      });
      if (!reviewed.body) {
        log.warn({ leadId: lead.id, reasons: reviewed.reasons }, "dm-ladder: DM failed shared voice check");
        continue;
      }
      const body = reviewed.body;
      const dmRow = {
        id: randomUUID(),
        kind: "dm" as const,
        angle: null,
        body,
        charCount: [...body].length,
        dmVoiceCheck: { pass: true, attempts: reviewed.attempts, reasons: reviewed.reasons },
      };
      // A DM row is never emptied by the reply gate (the policy only applies
      // the post-match clause to kind === "reply"), so null here means the DM
      // body itself was empty, which the schema already rejected upstream.
      // Guarded anyway rather than asserted.
      const dmOutbound = buildOutbound({ lead, postText, payload, anchors: [], drafts: [dmRow] });
      if (!dmOutbound) {
        log.warn({ leadId: lead.id }, "dm-ladder: outbound empty; skipping");
        continue;
      }
      await postOutbound(dmOutbound);
      drafted++;
      log.info(
        { leadId: lead.id, handle: authorHandle, rung: rung.index, label: rung.label, sentCount },
        "dm-ladder: queued rung DM",
      );
    } catch (err) {
      log.error(
        { leadId: lead.id, err: (err as Error).message },
        "dm-ladder: generation failed",
      );
    }
  }
  return drafted;
}

/** Placeholder "post" text for an intro DM — there is no source post; this DM is
 *  relationship outreach, not a reply. Surfaced in the approval detail so the
 *  operator sees WHY there's no post to read above the draft. */
export const INTRO_DM_POST_TEXT = "(intro DM — relationship outreach, not a reply to a post)";

export interface RunIntroDmTickArgs {
  log: Logger;
  instance: ActiveInstance;
  /** People claimed + stamped by claimIntroDmPeople (each gets exactly one DM). */
  claimedPeople: IntroDmPerson[];
  runner: CodexRunner;
  postOutbound: (body: OutboundIn) => Promise<{ id: string; approval_id: string }>;
  /**
   * Optional per-person status hook (kept symmetric with the reply path's
   * markStatus). The intro DM has no lead row to advance — the claim already
   * stamped intro_dm_drafted_at — so this is purely for observability/tests. No-op
   * when absent.
   */
  markStatus?: (args: {
    fsdProfileId: string;
    status: "drafted" | "errored";
    meta?: Record<string, unknown>;
  }) => Promise<void>;
}

/**
 * One-time INTRO DM pass (Lyra). For each watchlist person the caller already
 * CLAIMED + STAMPED (claimIntroDmPeople — so each person is processed exactly
 * once, ever), draft a single warm relationship-building DM that references their
 * work and asks what they're building. NO pitch. Queue it for approval as a
 * synthetic, POST-LESS lead (kind="dm"), draft-only — Lyra never auto-sends.
 *
 * Fail-open PER PERSON: a draft/parse/post failure for one person logs + continues
 * to the next; it never aborts the tick. (The person was already stamped by the
 * claim, so a failure means that one intro DM is lost — acceptable, matching the
 * claim-removes-flag pattern.) Returns the count of DMs actually queued.
 */
export async function runIntroDmTick(args: RunIntroDmTickArgs): Promise<number> {
  const { log, instance, claimedPeople, runner, postOutbound, markStatus } = args;
  if (claimedPeople.length === 0) return 0;
  const routing = linkedinInternRouting(instance);
  let drafted = 0;

  for (const person of claimedPeople) {
    try {
      const prompt = renderIntroDmPrompt(person);
      const draftArgs = {
        bucket: "drafter-codex",
        routing,
        orgId: instance.org_id,
        instanceId: instance.id,
        worker: "drafter",
        agentRole: "linkedin_intern",
        system: SYSTEM_LINKEDIN_INTRO,
        prompt,
      } satisfies Parameters<CodexRunner["draft"]>[0];
      const res = await runner.draft(draftArgs);
      const parsed = IntroDmOutput.safeParse(safeJsonParse(res.text));
      if (!parsed.success) {
        log.error(
          { fsdProfileId: person.fsdProfileId, raw: res.text.slice(0, 200) },
          "intro-dm: drafter output schema fail; skipping person",
        );
        await markStatus?.({ fsdProfileId: person.fsdProfileId, status: "errored", meta: { error: "schema" } });
        continue;
      }

      // Hard voice backstop: strip em dashes (a top AI tell) + any emoji outside
      // the {💀 😭 😛} allowlist, then recompute char_count off the cleaned body so
      // the inbox count matches what ships. The model can't be trusted to self-restrict.
      const reviewed = await refineDmVoice({
        body: stripDisallowedEmoji(stripEmDashes(parsed.data.body)),
        charLimit: 700,
        regenerate: async (feedback) => {
          const result = await runner.draft({ ...draftArgs, prompt: `${prompt}\n\n${feedback}` });
          const revised = IntroDmOutput.safeParse(safeJsonParse(result.text));
          return revised.success ? stripDisallowedEmoji(stripEmDashes(revised.data.body)) : null;
        },
      });
      if (!reviewed.body) {
        log.warn({ fsdProfileId: person.fsdProfileId, reasons: reviewed.reasons }, "intro-dm: DM failed shared voice check");
        await markStatus?.({ fsdProfileId: person.fsdProfileId, status: "errored", meta: { error: "dm-voice", reasons: reviewed.reasons } });
        continue;
      }
      const body = reviewed.body;
      const charCount = [...body].length;

      // Synthetic, POST-LESS lead. There is no source post — this is a first-touch
      // DM — so the lead fields describe the PERSON, not a post: a stable
      // `<fsd>:intro` id, the placeholder post text, the person's profile URL, and
      // a single kind="dm" draft. No autoSend (Lyra is draft-only).
      const publicIdOrFsd = person.publicId || person.fsdProfileId;
      const outbound: OutboundIn = {
        leadId: `${person.fsdProfileId}:intro`,
        batchNumber: null,
        platform: "linkedin",
        authorHandle: person.publicId ?? person.fsdProfileId,
        authorId: person.fsdProfileId,
        authorFollowers: null,
        allowsDms: null,
        originalPostId: `${person.fsdProfileId}:intro`,
        originalPostText: INTRO_DM_POST_TEXT,
        originalPostUrl: `https://www.linkedin.com/in/${publicIdOrFsd}/`,
        postedAt: null,
        matchedTrigger: null,
        drafts: [
          {
            id: randomUUID(),
            kind: "dm",
            angle: null,
            body,
            charCount,
            dmVoiceCheck: { pass: true, attempts: reviewed.attempts, reasons: reviewed.reasons },
          },
        ],
        tier: null,
        postKind: "intro_dm",
        verifierMeta: null,
        // NO autoSend block — Lyra never auto-sends.
      };
      await postOutbound(outbound);
      drafted++;
      await markStatus?.({ fsdProfileId: person.fsdProfileId, status: "drafted", meta: { engine: res.engine, model: res.model } });
      log.info(
        { fsdProfileId: person.fsdProfileId, handle: person.publicId ?? person.fsdProfileId, chars: charCount },
        "intro-dm: queued one-time intro DM",
      );
    } catch (err) {
      // Fail-open per person: one failure must never abort the tick (or strand the
      // other claimed people). The person is already stamped, so this DM is lost.
      log.error(
        { fsdProfileId: person.fsdProfileId, err: (err as Error).message },
        "intro-dm: generation failed; continuing",
      );
      await markStatus?.({ fsdProfileId: person.fsdProfileId, status: "errored", meta: { error: (err as Error).message } }).catch(() => {});
    }
  }
  return drafted;
}
