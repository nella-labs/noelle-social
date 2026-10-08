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
  ]).filter((value) => !vaultSet.has(value)).slice(0, 12);
  return [...sentReplies, ...vaultAnchors];
}

/**
 * Render the exact pinned-writer evidence used by faithful Account Feeder mode
 * into the verifier's compact voice context. Without this, the writer is told
 * to adopt the pinned voice while the judge sees only the operator's base
 * history and rejects the writer for following its instruction.
 */
export function faithfulVerifierVoiceAnchors(style: StyleForPrompt | null | undefined): string[] {
  if (!style) return [];
  const seen = new Set<string>();
  const anchors: string[] = [];
  for (const exemplar of style.exemplars) {
    const body = exemplar.body.trim();
    if (!body || seen.has(body)) continue;
    seen.add(body);
    const handle = exemplar.accountHandle.trim().replace(/^@/, "");
    anchors.push(`${handle ? `@${handle}: ` : ""}${body.slice(0, 320)}`);
  }
  const notes = style.styleNotes.trim();
  if (notes) anchors.push(`Voice notes: ${notes.slice(0, 600)}`);
  return anchors;
}

const NON_VOICE_ARTIFACT_FILES = new Set([
  "personal-brand-state.md",
]);

function usableVoiceAnchor(anchor: {
  snippet: string;
  source?: { filePath?: string };
}): boolean {
  const snippet = anchor.snippet.trim();
  const fileName = anchor.source?.filePath?.split("/").at(-1)?.toLowerCase();
  if (!snippet || (fileName && NON_VOICE_ARTIFACT_FILES.has(fileName))) return false;
  return !snippet.includes("{{")
    && !snippet.includes("}}")
    && !snippet.includes("<!--")
    && !snippet.includes("-->");
}

// Process-wide SHAPE rotation for Vega's replies (X_FORM_VARIANTS). One instance
// per worker process so the "no shape repeats within the last N" guarantee holds
// across leads AND across ticks, not just within one batch. See @noelle/runtime
// formVariants.ts. Exported for tests.
export const xFormVariantRotation = createFormVariantRotation(X_FORM_VARIANTS);

// Process-wide gen-z MARKER rotation, for the same reason: the point of the
// lane is that the feed does not say "ngl" five replies running, and a
// per-lead rotation would have no memory to enforce that with. See
// @noelle/runtime genzMarkers.ts. Exported for tests.
export const xGenZMarkerRotation = createGenZMarkerRotation(4, { platform: "x" });

// TONE_FIRST_ENERGIES now lives in @noelle/runtime (formVariants.ts), next to
// ENERGY_SHAPE_IDS, because the two must agree. Note the behaviour CHANGED with
// the tone-first split: a tone-first energy no longer means "no shape at all" —
// TONE_FIRST_SHAPE_SHARE of those leads take an energy-scoped shape, and the
// rest take the register. Shape and register stay mutually exclusive, because
// both claim authority over reply length.

/**
 * Should this lead be drafted by the SMARTER (costlier) model?
 *
 *   useOpus = likes > likesThreshold
 *          || (replies > repliesThreshold && !commentBait)
 *
 * Likes are always a reliable signal. The REPLIES trigger is suppressed for
 * engagement-bait posts (the classifier's comment_bait flag): a comment-farming
 * CTA inflates its reply count with junk, not real discussion, so paying for the
 * expensive model on it is money burned. The likes trigger still applies.
 * Missing/non-finite engagement counts as 0 and never escalates.
 *
 * Ported from Lyra, with `comments` renamed to `replies` for X.
 */
export function decideOpus(args: {
  likes: number | null | undefined;
  replies: number | null | undefined;
  commentBait: boolean;
  likesThreshold: number;
  repliesThreshold: number;
}): { useOpus: boolean; likes: number; replies: number; commentBait: boolean } {
  const likes = Number.isFinite(args.likes) ? (args.likes as number) : 0;
  const replies = Number.isFinite(args.replies) ? (args.replies as number) : 0;
  const useOpus =
    likes > args.likesThreshold || (replies > args.repliesThreshold && !args.commentBait);
  return { useOpus, likes, replies, commentBait: args.commentBait };
}

export interface RunDrafterTickArgs {
  log: Logger;
  instance: ActiveInstance;
  /**
   * Used to tell the operator the FIRST time the budget cap blocks work in a
   * period. Recording a budget_escalations row is not telling anyone — the
   * banner it was built for is still unbuilt — so without this the agents just
   * go quiet. Optional: omit and the block is recorded silently, as before.
   */
  notifier?: BudgetAlertDeps["notifier"];
  /**
   * The operator's own approved replies, paired with the posts they answered.
   * Fetched once per tick rather than per lead: the set barely moves between
   * leads and the query is the same for all of them.
   */
  voiceExemplars?: ReadonlyArray<{ post: string; reply: string }>;
  claimedLeads: LeadRow[];
  runner: CodexRunner;
  kb: KnowledgeBase;
  postOutbound: (body: OutboundIn) => Promise<{ id: string; approval_id: string }>;
  markStatus: (args: { leadId: string; status: "drafted" | "errored" | "skipped" | "classified"; meta?: Record<string, unknown> }) => Promise<void>;
  /**
   * Minimum `max(anchor.score)` required to draft for a lead. Leads whose
   * top anchor falls below this threshold are skipped without invoking the
   * LLM. Default 1.5 — calibrated against GCS-backed Nella's
   * `score / log2(max(2, body.length/50))` formula and observed top-K=8
   * score ranges of ~[0.3, 8.0]. Tunable via `DRAFTER_RELEVANCE_THRESHOLD`
   * (apps/x-intern/src/env.ts).
   */
  relevanceThreshold?: number;
  /**
   * Vault subdirs to scope VOICE retrieval to (empty/undefined → unscoped,
   * exactly as today). See docs/grounded-drafting.md.
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
   * Few-shot exemplars from the operator's past SENT/EDITED replies. Injected
   * once per tick (same for every lead). Empty/undefined → no examples block.
   */
  examples?: string[];
  /**
   * Post-draft verifier. When enabled, each lead's replies are graded against
   * the grounding context after drafting; a failing verdict triggers up to
   * `retries` regenerations with the critique appended, then the best attempt
   * is queued (with the verdict attached). `makeCalls(priority)` returns the
   * judge call(s): one cheap judge by default, N adversarial judges for
   * high-value (watchlist/priority) leads. Injected so the worker owns the
   * model/routing/budget and the tick stays unit-testable.
   */
  verify?: {
    enabled: boolean;
    retries: number;
    /** Drop ordinary low-voice drafts after retries; requested/conversation replies stay reviewable. */
    voiceFloor?: number;
    makeCalls: (
      priority: boolean,
      options?: {
        directRouting?: boolean;
        codexSubscriptionOnly?: boolean;
        codexReasoningEffort?: "low" | "medium" | "high" | "xhigh";
      },
    ) => VerifierCall[];
  };
  /**
   * Minimum classifier quality score (0-1) a NON-priority lead must clear to be
   * drafted. A lead the classifier scored below this — or could not score at all
   * (null) — is skipped without an LLM call; the classifier's `label=other`
   * leads carry a null score and are exactly the junk we don't want to reply to.
   * Watchlist (priority) leads bypass it (they're forced score=1). Default 0 =
   * gate DISABLED (back-compat); the worker passes X_Q_THRESHOLD/100.
   */
  qualityThreshold?: number;
  /**
   * Engagement thresholds for escalating a lead to the smarter model. A post
   * with real traction earns a better draft; a comment-bait post's inflated
   * reply count is ignored (see decideOpus). 0/omitted keeps every lead on the
   * base model, which is today's behaviour.
   */
  opusLikesThreshold?: number;
  opusRepliesThreshold?: number;
  /** Complete standing rules admitted once before this tick's work claims. */
  patternRules?: readonly DynamicPattern[];
  /**
   * Optional SQL handle for policy side-effects (pause_on_5xx flips,
   * budget escalation inserts). Tests can omit it; the policy checks
   * no-op when absent.
   */
  sql?: Sql;
  /** Shared-memory bus (optional). Emits a `draft.created` event per lead drafted. */
  bus?: Bus;
  /**
   * Push the operator directly about a notification too important to answer
   * with an agent (an intro, an investor, a job, a meeting request). Injected so
   * the tick stays unit-testable and so a missing Pushover channel is simply a
   * no-op rather than a failed lead. Omitted ⇒ pins are logged and skipped.
   */
  pinNotification?: (args: { title: string; message: string; url?: string }) => Promise<boolean>;
  /**
   * Vision caption fn. When a lead's payload carries `images`, the tick captions
   * them and injects "THE POST'S IMAGE SHOWS:" into the prompt so the drafter can
   * react to the visual. Omit (no key, vision disabled) and drafting proceeds
   * with no caption — fail-open throughout.
