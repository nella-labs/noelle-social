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
