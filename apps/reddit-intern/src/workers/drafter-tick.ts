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
