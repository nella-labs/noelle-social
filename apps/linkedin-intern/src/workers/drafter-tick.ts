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
