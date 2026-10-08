import { readSourceTimestamp } from "@noelle/runtime/source-values";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Sql } from "postgres";
import type { Logger } from "../lib/logger.js";
import type { ActiveInstance } from "../lib/activation.js";
import type { LeadRow } from "../lib/leads-db.js";
import type { CodexRunner } from "../lib/codex-runner.js";
import type { OutboundIn } from "@noelle/contracts";
import { composeObjectiveDirective, parseBrandConfig, OutboundFactualContextSchema } from "@noelle/contracts";
import type { Bus, KnowledgeBase, VerifierCall, DraftToVerify, VerifyContext, DraftVerdict, CaptionFn, BudgetAlertDeps } from "@noelle/runtime";
import {
  BudgetExceededError,
  stripDisallowedEmoji,
  applyReplyEmojiPolicy,
  verifyTiered,
  toOutboundVerifierMeta,
  captionImages,
  readReplyRequest,
  refineDmVoice,
} from "@noelle/runtime";
import {
  DM_RUNGS,
  pickRung,
  countSentDmsToAuthor,
  getRecentDmsToAuthor,
  type DmRung,
  X_FORM_VARIANTS,
  LIGHT_EXCLUDED_VARIANT_IDS,
  SHAPES_WITH_FREE_OPENER,
  SHAPES_BANNING_QUESTIONS,
  TONE_FIRST_SHAPE_SHARE,
  TONE_FIRST_ENERGIES,
  shapesExcludedForEnergy,
  createFormVariantRotation,
  renderAssignedShapeBlock,
  X_OPENING_MOVES,
  pickOpeningMove,
  renderOpeningMoveBlock,
  createGenZMarkerRotation,
  renderGenZMarkerBlock,
  genzMarkerRateFromEnv,
  type FormVariant,
  type GenZMarker,
} from "@noelle/runtime";
import {
  buildDrafterSystem,
  renderConversationBlock,
  renderPersonProfile,
  renderOperatorFacts,
  type ConversationBrief,
  type OwnAccountFacts,
} from "../lib/prompts.js";
import { readOwnAccountSnapshot } from "../lib/own-account.js";
import {
  pickRegister,
  pickRegisterForEnergy,
  renderRegisterBlock,
  renderEnergyHint,
  detectPostRegister,
  detectPostEnergy,
  energyToRegister,
  type PostEnergy,
} from "../lib/register.js";
import { renderCommentDigest, type SiblingComment } from "@noelle/runtime/comment-digest";
// Account Feeder — the "voice of our posts" STYLE layer (shared engine in
// @noelle/runtime; the X corpus loaders live in lib/x-account-feeder-db.ts).
import {
  selectStyleExemplars,
  buildStyleSource,
  readFaithfulVoices,
  readFaithfulVoiceWeights,
  readStyleExemplarKinds,
  pickFaithfulVoice,
  pinnedSelectConfig,
  resolveStyleSourceHandle,
} from "@noelle/runtime";
import type { StyleExemplarRow, UltraProfileRow, StyleForPrompt, DynamicPattern } from "@noelle/runtime";
import { loadActivePatternRules } from "../lib/pattern-breaker-db.js";
import {
  listStyleExemplars,
  listStyleExemplarsForHandle,
  listUltraProfiles,
  getUltraProfileForHandle,
  listFeederSources,
} from "../lib/x-account-feeder-db.js";
import { stripEmDashes } from "@noelle/runtime/voice-sanitize";
import { getWatchlistObjectives, type WatchlistObjectiveEntry } from "../lib/watchlist.js";
import { getWatchlistProfiles, type WatchlistProfileRow } from "../lib/profiles-db.js";
import { gateReply } from "../lib/reply-diversity.js";
import { makesCommitment, commitmentReason, detectCommitments } from "@noelle/runtime/commitment-guard";
import { triageNotification, renderPin } from "@noelle/runtime/notification-triage";
import { xInternRouting, opusOverrideRouting } from "../lib/routing.js";
import {
  isServerSideModelError,
  recordModelError,
  resetModelErrorCounter,
} from "../lib/error-tracker.js";
import { recordBudgetEscalation } from "../lib/budget-escalation.js";

// `char_count` tolerates ANY model sloppiness — absent, null, string, float
// (`.catch(undefined)` swallows all of it). charCount is recomputed off the
// cleaned body at row creation anyway, so a good body must never error the
// lead over a bad count (Lyra lost 14/37 leads to this on 2026-07-19; same
// schema, same failure mode).
const DrafterDrafts = z.object({
  drafts: z
    .array(
      z.object({
        angle: z.enum(["empathetic", "technical", "contrarian"]),
        body: z.string().min(1),
        char_count: z.number().int().nonnegative().nullish().catch(undefined),
      }),
    )
    .min(1),
  // One cold-outreach DM per lead, sent alongside the three public replies.
  // Optional so a model that omits it still parses (the lead just ships
  // reply-only) rather than erroring the whole tick.
  dm: z
    .object({
      body: z.string().min(1),
      char_count: z.number().int().nonnegative().nullish().catch(undefined),
    })
    .optional(),
});
const DrafterSkip = z.object({ skip: z.string().min(1) });
// Accept explicit skip responses defensively without turning a rejected lead
// into a schema error. Selection remains the upstream gate's responsibility.
// safeJsonParse normalizes plain-text skip responses into the same shape.
const DrafterOutput = z.union([DrafterDrafts, DrafterSkip]);

// Low-voice skips never reach outbound, so the ordinary verifier_meta is lost.
// Persist only bounded, fixed-vocabulary diagnostics on the local lead row:
// free-form judge feedback can contain the post, a draft, or personal details.
const MAX_VOICE_DIAGNOSTIC_VERDICTS = 12;
const feedbackCategories = [
  { pattern: /unsupported|invented|unverified|unproven|fabricat|hallucinat|assum(?:e|ption)/i, reason: "unsupported claim", fix: "remove unsupported claim" },
  { pattern: /generic|vague|boilerplate|off.voice|unnatural|robotic|ai.slop/i, reason: "generic voice", fix: "use natural voice" },
  { pattern: /cop(?:y|ied|ies)|echo|paraphras|repeat.{0,24}post/i, reason: "echoes source", fix: "add an original point" },
  { pattern: /\bground(?:ing|ed)?\b|(?:lacks?|needs?|more|not).{0,20}(?:specific|concrete)|post.detail|source.detail/i, reason: "weak grounding", fix: "ground in a post detail" },
  { pattern: /relevan|off.topic|tangent|does not engage/i, reason: "weak relevance", fix: "address the post directly" },
  { pattern: /novel|said before|already told|repeat.{0,24}(?:person|author)/i, reason: "repeats prior reply", fix: "take a new angle" },
  { pattern: /divers|same opener|same shape|recent repl/i, reason: "repeats feed pattern", fix: "vary the reply shape" },
  { pattern: /format|punctuat|emoji|char(?:acter)?.limit/i, reason: "format issue", fix: "repair the format" },
] as const;

function diagnosticFeedback(value: string, kind: "reason" | "fix", scores: DraftVerdict["scores"]): string {
  // Never persist any substring from `value`. The result is drawn only from
  // fixed labels, even when a judge embeds names, URLs, or draft text.
  const categories = feedbackCategories
    .filter(({ pattern }) => pattern.test(value.slice(0, 1024)))
    .slice(0, 2);
  if (categories.length > 0) return categories.map((category) => category[kind]).join("; ");
  const dimensions = ["voice", "grounding", "relevance", "format", "novelty", "diversity"] as const;
  const weakest = dimensions.reduce((current, key) => scores[key] < scores[current] ? key : current);
  const fallback = {
    voice: { reason: "low voice score", fix: "use natural voice" },
    grounding: { reason: "low grounding score", fix: "ground in a post detail" },
    relevance: { reason: "low relevance score", fix: "address the post directly" },
    format: { reason: "low format score", fix: "repair the format" },
    novelty: { reason: "low novelty score", fix: "take a new angle" },
    diversity: { reason: "low diversity score", fix: "vary the reply shape" },
  } as const;
  return fallback[weakest][kind];
}

function diagnosticScores(scores: DraftVerdict["scores"]): DraftVerdict["scores"] {
  const safe = (score: number) => Number.isFinite(score)
    ? Math.round(Math.max(0, Math.min(1, score)) * 1000) / 1000 : 0;
  return {
    voice: safe(scores.voice), grounding: safe(scores.grounding),
    relevance: safe(scores.relevance), format: safe(scores.format),
    novelty: safe(scores.novelty), diversity: safe(scores.diversity),
  };
}

function diagnosticVerdict(verdict: DraftVerdict, phase: "initial" | "repair" | "final", attempt: number, candidate: number) {
  return {
    phase, attempt, candidate,
    pass: verdict.pass && verdict.judgeOk === true,
    judge_ok: verdict.judgeOk === true,
    judge_provider: verdict.judgeProvider ?? "none",
    scores: diagnosticScores(verdict.scores),
    reason: diagnosticFeedback(verdict.reasons.slice(0, 3).join(" "), "reason", verdict.scores),
    fix: diagnosticFeedback(verdict.fix ?? "", "fix", verdict.scores),
  };
}

function verifierVoiceAnchors(args: {
  sentReplies?: readonly string[];
  pairedReplies?: ReadonlyArray<{ reply: string }>;
  vaultAnchors: readonly string[];
}): string[] {
  const normalize = (values: readonly string[]): string[] =>
    [...new Set(values.map((value) => value.trim()).filter(Boolean))];
  const vaultAnchors = normalize(args.vaultAnchors);
  const vaultSet = new Set(vaultAnchors);
  const sentReplies = normalize([
    ...(args.sentReplies ?? []),
    ...(args.pairedReplies ?? []).map((example) => example.reply),
