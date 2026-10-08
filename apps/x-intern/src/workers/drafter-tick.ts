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
   */
  captionFn?: CaptionFn;
  /**
   * Voice variety (NOELLE_DRAFTER_VARIETY). When enabled, each lead is assigned a
   * random "register" (ultra-short / hype / slang / punchy / normal) injected into
   * the REPLY-drafting prompt so replies vary in length + energy across the feed.
   * `rng` is injectable for deterministic tests (defaults to Math.random in the
   * worker). When disabled / omitted, no register is injected and drafts are
   * byte-identical to today. Only the reply drafts get a register — the DM is
   * untouched, and runDmRequestTick never touches this path.
   */
  variety?: {
    enabled: boolean;
    rng?: () => number;
    /**
     * Per-reply SHAPE rotation (X_FORM_VARIANTS). Injectable so tests are
     * deterministic; defaults to the module-level process-wide rotation so
     * consecutive replies never share a shape across leads AND across ticks.
     */
    formVariantRotation?: {
      next: (rng?: () => number, exclude?: readonly string[]) => FormVariant;
    };
    /**
     * Per-reply gen-z MARKER rotation. Same reason as the shape rotation: the
     * lane's whole point is that the feed does not repeat a marker, and only a
     * process-wide instance has the memory to enforce that. Injectable for
     * deterministic tests.
     */
    genzMarkerRotation?: {
      next: (rng?: () => number, energy?: PostEnergy | null) => GenZMarker | null;
    };
    /**
     * Share of leads offered a gen-z marker. Defaults to
     * genzMarkerRateFromEnv() (22%, `NOELLE_GENZ_MARKERS=0` to disable). Held
     * separately from `enabled` because the RATE is the design: the operator
     * asked for gen-z wording and for it not to be overdone in the same breath.
     */
    genzMarkerRate?: number;
  };
  /**
   * Post-energy mirroring (NOELLE_DRAFTER_ENERGY, default off). When enabled the
   * drafter detects the post's energy (celebration/joke/hot_take/vent/question/
   * analytical) and (a) picks an energy-aware register when variety is on — HYPE only
   * on a celebration, DEADPAN on a joke, never snark on a question — and (b) injects a
   * one-line energy hint so the reply MIRRORS the post: answer satire with satire, not
   * philosophy. Off/omitted → blind register + celebration/neutral style only,
   * byte-identical to today.
   */
  energy?: { enabled: boolean };
  /**
   * Sibling-comment "read the room" fetch (NOELLE_DRAFTER_COMMENT_ENERGY). When
   * provided, the tick fetches the top OTHER replies on each lead's post and injects a
   * digest so the reply matches the room's energy and never echoes a take already
   * made. The worker owns the Apify client / credential / spend + budget; this closure
   * just returns the normalized comments (or []). Fail-open: a throw is caught and
   * treated as no room context. Undefined → off, byte-identical to today.
   */
  fetchSiblingComments?: (lead: LeadRow) => Promise<SiblingComment[]>;
  /**
   * Recently-sent reply bodies used as the near-duplicate corpus for the
   * reply-diversity gate (NOELLE_REPLY_DIVERSITY_GATE). Empty/undefined → the
   * gate is a no-op and drafting is byte-identical to today.
   */
  replyPriors?: string[];
  /**
   * Per-person memory: the reply bodies Vega has ALREADY produced for one author
   * (sent + pending), newest first. Injected into the prompt as a do-not-repeat
   * list AND passed to the verifier as `priorRepliesToPerson`, which grades a
   * `novelty` dimension and regenerates a draft that re-says an old take.
   * Without it, a watchlist person who posts often gets the same angle every
   * time. Fail-open: a throw is caught and treated as no history.
   */
  getPriorReplies?: (a: {
    authorHandle: string | null;
    authorId?: string | null;
    excludeLeadId?: string | null;
    limit: number;
  }) => Promise<string[]>;
  /** How many prior replies to this person to inject. Default 3. */
  priorRepliesTopK?: number;
  /**
   * Feed-wide memory: Vega's most recent reply bodies across ALL authors. Fetched
   * ONCE per tick. Injected as an avoid-list so openers/phrasings vary feed-wide,
   * and passed to the verifier as `recentReplies`, whose deterministic diversity
   * leg regenerates a reply too structurally alike a recent one. This is the
   * prompt-side complement to the existing post-hoc `replyPriors` gate: that one
   * REJECTS a near-duplicate after the fact, this one prevents it being written.
   */
  getRecentPhrasings?: (a: {
    excludeLeadId?: string | null;
    limit: number;
  }) => Promise<string[]>;
  /** How many feed-wide recent replies to inject. Default 12. */
  recentPhrasingsTopK?: number;
  /**
   * Prompt-injection fence (NOELLE_DRAFTER_FENCE, default OFF). Passed straight
   * into renderPrompt.fenceUntrusted for every lead. Off/omitted → drafts
   * byte-identical to today.
   */
  fenceUntrusted?: boolean;
}

const DEFAULT_RELEVANCE_THRESHOLD = 6;

/**
 * Faithful multi-voice pool restriction, pure so it's unit-testable. When MORE
 * than one faithful voice is pinned, restrict a lead's exemplar pool to the ONE
 * voice picked for it — deterministic per lead (seeded on the post text) and
 * rotating across the feed, optionally biased by `weights` (parallel to
 * `voices`, e.g. 60/40). Fail-open: a chosen voice with no corpus returns the
 * full pool. Zero or one voice ⇒ the pool is returned untouched (a single pin
 * is already restricted at load time — byte-identical to today).
 */
export function poolForFaithfulLead(
  pool: StyleExemplarRow[],
  voices: string[],
  postText: string,
  weights?: number[],
): StyleExemplarRow[] {
  if (voices.length <= 1) return pool;
  const chosen = pickFaithfulVoice(voices, postText, weights);
  const filtered = pool.filter((c) => c.account_handle === chosen);
  return filtered.length ? filtered : pool;
}

export function xReplyStyleCorpusPlan(
  config: unknown,
  faithful: boolean,
): { primary: ("post" | "comment")[]; fallback: ("post" | "comment")[] } {
  const rawKinds = config && typeof config === "object"
    ? (config as { styleExemplarKinds?: unknown }).styleExemplarKinds
    : undefined;
  const hasExplicitKinds = Array.isArray(rawKinds)
    && rawKinds.length > 0
    && rawKinds.every((kind) => kind === "post" || kind === "comment");
  if (hasExplicitKinds) {
    return { primary: readStyleExemplarKinds(config), fallback: [] };
  }
  return faithful
    ? { primary: ["comment"], fallback: ["post"] }
    : { primary: ["post"], fallback: [] };
}

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
    voiceDirs,
    knowledgeDirs,
    knowledgeTopK = 4,
    examples,
    verify,
    qualityThreshold = 0,
    opusLikesThreshold = 0,
    opusRepliesThreshold = 0,
    sql,
    bus,
    captionFn,
    variety,
    replyPriors,
    getPriorReplies,
    priorRepliesTopK = 3,
    getRecentPhrasings,
    recentPhrasingsTopK = 12,
    fenceUntrusted = false,
  } = args;
  const voiceOpts =
    voiceDirs && voiceDirs.length ? { filterDirs: voiceDirs } : undefined;
  let processed = 0;

  // Operator brand config (persona/product/pitch/styles), parsed once per tick.
  const brand = parseBrandConfig(instance.brand_config);
  const operatorFacts = renderOperatorFacts(brand);

  // Feed-wide recent phrasings, fetched ONCE per tick (not per lead) — the
  // avoid-list that keeps openers varied across the whole feed. Fail-open.
  const recentPhrasings = getRecentPhrasings
    ? await getRecentPhrasings({ limit: recentPhrasingsTopK }).catch(() => [])
    : [];

  // Per-watchlist-person objectives (keyed by lowercased handle), fetched once
  // per tick. Empty for leads whose author isn't a watchlist person.
  const objectivesByHandle: Map<string, WatchlistObjectiveEntry> = sql
    ? await getWatchlistObjectives(sql, instance.id)
    : new Map();

  // Per-watchlist-person PROFILES (summary/topics/tone/engagement), keyed by
  // lowercased handle, fetched once per tick. The profiler writes these but the
  // drafter never read them — profiles were orphaned on X. We now ground every
  // watchlist reply in who the person actually is. Empty for non-watchlist leads.
  const profilesByHandle: Map<string, WatchlistProfileRow> = sql
    ? await getWatchlistProfiles(sql, instance.id)
    : new Map();

  // Active Pattern Breaker rules — over-used structures the breaker discovered
  // from the operator's last-N sent replies + published posts. Loaded ONCE per
  // tick (instance-scoped) and threaded into every reply draft's SYSTEM prompt +
  // verifier. A failed or incomplete rule read holds drafting for this tick.
  // Empty until X_PATTERN_BREAKER has produced rules (or the operator added manual ones) — byte-identical to today.
  const patternRules: DynamicPattern[] = args.patternRules
    ? [...args.patternRules]
    : sql
      ? await loadActivePatternRules(sql, {
          orgId: instance.org_id,
          agentInstanceId: instance.id,
          role: "x_intern",
        })
      : [];

  // The operator's OWN account (handle + follower/following/post counts), read
  // ONCE per tick off the shared memory bus. This is what stops Vega inventing a
  // first-person stat: with the real number in the prompt it has no gap to fill,
  // and with NO number the block says so explicitly. Passing the wrapper even
  // when the snapshot is null is deliberate — `null` still renders the "you do
  // not know these" half. Fail-open: readOwnAccountSnapshot never throws.
  const ownAccount: OwnAccountFacts = {
    snapshot: bus ? await readOwnAccountSnapshot(bus) : null,
    now: new Date(),
  };

  // Account Feeder — the "voice of our posts" STYLE layer. Load this instance's
  // style corpus + ultra profiles ONCE per tick, gated on NOELLE_DRAFTER_STYLE.
  // The per-lead selector below picks a few exemplars matched to each post and
  // injects their FORM (rhythm/hooks), never their content. If the operator PINNED
  // a handle (e.g. eliana_jordan) we restrict the pool to that one account and
  // floor the exemplar count so the named voice actually lands. Fail-open: any
  // error → empty pool → no STYLE block (drafts exactly as before).
  // Read the style gate + pool size straight off process.env (like the selector
  // does) — fail-open, and never triggers strict env-schema validation in tests.
  const styleGateOn = /^(1|true|yes|on)$/i.test((process.env["NOELLE_DRAFTER_STYLE"] ?? "").trim());
  const feederConfig = instance.account_feeder_config ?? null;
  // Faithful-voice pin: an explicit faithfulVoices list, or the legacy single
  // pinnedStyleHandle folded into a 1-element list (readFaithfulVoices), so an
  // existing single-pin instance behaves byte-identically. With MORE than one
  // voice, each lead deterministically gets ONE of them (pickFaithfulVoice,
  // seeded on the post text, optionally biased by faithfulVoiceWeights) so a
  // reply always sounds like a single real writer, rotating across the feed.
  const faithfulVoices = readFaithfulVoices(feederConfig);
  const faithfulVoiceWeights = readFaithfulVoiceWeights(feederConfig);
  const styleFaithful = faithfulVoices.length > 0;
  const styleCorpusPlan = xReplyStyleCorpusPlan(feederConfig, styleFaithful);
  const styleKinds = styleCorpusPlan.primary;
  let stylePool: StyleExemplarRow[] = [];
  let styleProfiles: UltraProfileRow[] = [];
  let styleSelectConfig: unknown = feederConfig;
  // Canonical corpus handles parallel to faithfulVoices (so the weights list
  // stays aligned after resolution). Non-empty only in faithful mode.
  let resolvedVoices: string[] = [];
  if (sql && (styleGateOn || styleFaithful)) {
    try {
      const poolLimit = Math.min(500, Math.max(1, Number(process.env["NOELLE_DRAFTER_STYLE_POOL"]) || 60));
      if (faithfulVoices.length > 0) {
        const sources = await listFeederSources(sql, {
          agentInstanceId: instance.id,
          platform: "x",
        });
        const sourceRefs = sources.map((s) => ({ handle: s.handle, displayName: s.displayName }));
        resolvedVoices = faithfulVoices.map(
          (voice) => resolveStyleSourceHandle(voice, sourceRefs) ?? voice,
        );
        // Honor an explicit corpus choice. Otherwise a faithful X reply learns
        // from the pinned writer's actual comments, falling back to posts only
        // when that source has no comment corpus.
        const loadPinnedPool = (handle: string, kinds: ("post" | "comment")[]) => Promise.all(
          kinds.map((kind) =>
            listStyleExemplarsForHandle(sql, {
              agentInstanceId: instance.id,
              platform: "x",
              kind,
              handle,
              limit: poolLimit,
            }),
          ),
        );
        const pools = await Promise.all(resolvedVoices.map(async (handle) => {
          const primary = (await loadPinnedPool(handle, styleKinds)).flat();
          if (primary.length > 0 || styleCorpusPlan.fallback.length === 0) return primary;
          return (await loadPinnedPool(handle, styleCorpusPlan.fallback)).flat();
        }));
        stylePool = pools.flat();
        const profs = await Promise.all(
          resolvedVoices.map((handle) =>
            getUltraProfileForHandle(sql, {
              agentInstanceId: instance.id,
              platform: "x",
              handle,
            }),
          ),
        );
        styleProfiles = profs.filter((p): p is NonNullable<(typeof profs)[number]> => p != null);
        styleSelectConfig = pinnedSelectConfig(feederConfig);
      } else {
        const pools = await Promise.all(styleKinds.map((kind) =>
          listStyleExemplars(sql, { agentInstanceId: instance.id, platform: "x", kind, limit: poolLimit }),
        ));
        stylePool = pools.flat();
        styleProfiles = await listUltraProfiles(sql, {
          agentInstanceId: instance.id,
          platform: "x",
        });
      }
    } catch {
      // fail-open: a corpus-load failure just means no STYLE this tick (as before).
      stylePool = [];
      styleProfiles = [];
    }
  }

  for (const lead of claimedLeads) {
    const payload = lead.payload as {
      text?: string;
      url?: string;
      followers?: number;
      posted_at?: string;
      images?: string[];
    };
    const replyRequest = readReplyRequest(payload);
    // Match the outbound DM gate before asking the model to write one. Most
    // browser-observed leads are priority replies, so DM text here is wasted
    // generation and competes with the single public reply we actually need.
    const dmEligible = !replyRequest && !lead.priority && (instance.dm_autodraft_enabled ?? false);
    const postText = payload.text ?? "";
    // The lead's REAL tweet time (set at discovery from the tweet's own
    // created_at). Forward it so the outbound upsert doesn't overwrite
    // noelle.leads.posted_at with a draft-time "now" — that clobber corrupted
    // the post age and erased the evidence behind stale leads in the inbox.
    const postedAt = readSourceTimestamp(payload.posted_at);
    if (!postText) {
      await markStatus({ leadId: lead.id, status: "skipped", meta: { skip_reason: "empty post text" } });
      continue;
    }

    // NOTIFICATION TRIAGE. A lead the actuator harvested because someone
    // replied to us does NOT automatically deserve a reply: most inbound is a
    // thanks or an emoji (answering it is noise and burns write budget), and a
    // few are real opportunities where an AI answer is actively the wrong move.
    // Runs BEFORE retrieval so an ignored lead costs zero LLM spend.
    if (!replyRequest && (payload as { source?: string }).source === "notification") {
      const decision = triageNotification({
        text: postText,
        author: lead.author_handle,
        priorTurns: Number((payload as { prior_turns?: number }).prior_turns ?? 0),
      });
      if (decision.verdict !== "reply") {
        let pinned = false;
        if (decision.verdict === "pin" && args.pinNotification) {
          // Escalate instead of answering — and deliberately draft NOTHING, so
          // there is no half-written reply sitting in the inbox tempting a
          // one-click send on something that needs a human.
          const pin = renderPin({
            platform: "x",
            author: lead.author_handle,
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
        // An UNDELIVERED pin must never be filed as 'skipped'. That would be the
        // worst outcome this feature can produce: a real opportunity (an
        // investor, a job, an intro) with no reply drafted AND no push — silently
        // gone. 'errored' is the repo's never-silently-lost status, so it
        // surfaces loudly instead of vanishing into the skip pile.
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

    // Classifier quality gate. A non-priority lead must clear the quality bar to
    // be worth a reply. Watchlist (priority) leads bypass — every post from a
    // watchlisted person gets a reply regardless of score. Disabled when
    // qualityThreshold is 0.
    //
    // A NULL score means the classifier could not score the lead, NOT that the
    // lead is junk. The old condition dropped null alongside sub-threshold, on
    // the belief that `label=other` junk lands in the null bucket — it does not:
    // over the last 90 days 399 `other` leads carry a score and 193 do not, and
    // velocity_score is non-nullable in the classifier's schema, so a scored
    // classification always produces a number. Null on a lead that reached the
    // drafter therefore means the scoring call FAILED (the `too_old` and
    // `non_english` paths short-circuit earlier and never get here).
    //
    // So the old gate was fail-CLOSED: a classifier outage silently dropped every
    // keyword lead, which is the opposite of the documented fail-open contract
    // Lyra and Orion implement. An unscored lead now passes to the drafter, where
    // the relevance gate and the post-draft verifier still apply.
    if (
      qualityThreshold > 0 &&
      !replyRequest &&
      !lead.priority &&
      lead.classifier_score != null &&
      lead.classifier_score < qualityThreshold
    ) {
      log.info(
        { leadId: lead.id, classifierScore: lead.classifier_score, qualityThreshold },
        "drafter skipped lead below classifier quality threshold",
      );
      await markStatus({
        leadId: lead.id,
        status: "skipped",
        meta: {
          skip_reason: `below-quality-threshold (score=${lead.classifier_score ?? "null"} < ${qualityThreshold})`,
          classifier_score: lead.classifier_score,
          quality_threshold: qualityThreshold,
        },
      });
      continue;
    }

    try {
      const retrievedAnchors = await kb.search(postText, 8, voiceOpts).catch((err) => {
        log.warn({ err: (err as Error).message }, "knowledge base search failed; drafting with no anchors");
        return [];
      });
      // Generated brand summaries and unrendered templates are not examples of
      // how the operator speaks. Keep them out of both writer and verifier
      // prompts; recent sent replies remain the primary voice evidence.
      const anchors = retrievedAnchors.filter(usableVoiceAnchor);

      // Retrieval-score gate. Replaces the old "model decides skip/no-fit"
      // behaviour in SYSTEM_X. If the strongest anchor is below the
      // configured threshold, the lead is too far from the knowledge base to
      // produce an authentic reply — skip without spending an LLM call.
      const topAnchorScore = retrievedAnchors.length === 0
        ? 0
        : Math.max(...retrievedAnchors.map((a) => a.score));
      // Watchlist (priority) leads bypass the relevance gate entirely — every
      // post from a watchlisted person must get a drafted reply. Anchors are
      // still fetched above for voice grounding; we just never skip-on-score.
      if (!replyRequest && !lead.priority && topAnchorScore < relevanceThreshold) {
        log.info(
          { leadId: lead.id, topAnchorScore, relevanceThreshold },
          "drafter skipped lead below relevance threshold",
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
      // dirs, so the drafter can ground factual claims about the offer instead
      // of inventing them from model priors. Skipped entirely when no knowledge
      // dirs are configured (managed prod today). Fail-open to no knowledge.
      const knowledge =
        knowledgeDirs && knowledgeDirs.length && knowledgeTopK > 0
          ? await kb
              .search(postText, knowledgeTopK, { filterDirs: knowledgeDirs })
              .catch((err) => {
                log.warn(
                  { err: (err as Error).message },
                  "knowledge retrieval failed; drafting without product knowledge",
                );
                return [];
              })
          : [];

      // Optional visual context falls back to empty on ordinary failure.
      // Denied model admission propagates to the existing budget hold policy.
      const imageCaption = await captionImages({
        imageUrls: payload.images ?? [],
        postText,
        ...(captionFn ? { captionFn } : {}),
      });

      // Detect the post's ENERGY once (label-first: a persisted energy label from the
      // classifier, then classifier_label, then text heuristics). Drives the
      // energy-aware register, the prompt energy-hint, and — collapsed to
      // celebration/neutral — the Account Feeder style block. Gated on
      // NOELLE_DRAFTER_ENERGY; off → null and behavior is byte-identical to today.
      const postEnergy = args.energy?.enabled
        ? detectPostEnergy(postText, {
            classifierLabel: lead.classifier_label,
            energyLabel: (payload as { energy?: string | null }).energy ?? null,
          })
        : null;
      // The Account Feeder + verifier want the binary celebration/neutral register.
      // Derive it from the richer energy when energy is on; else keep old detection.
      const postRegister = postEnergy
        ? energyToRegister(postEnergy)
        : detectPostRegister(postText, lead.classifier_label);

      // Voice variety, one of two mutually exclusive mechanisms per lead:
      //
      //  SHAPE (default) — rotate this reply's FORM through X_FORM_VARIANTS so
      //    the feed stops reading as one mold. This is what lets Vega answer with
      //    a single word ('brutal') on one lead and a 200-char three-beat take on
      //    the next. Unlike Lyra's #498 the shape is a STANDALONE block, so it
      //    fires on every lead instead of only pinned-voice ones.
      //  REGISTER (strong energies only) — on a joke/celebration/vent/hot take,
      //    mirroring the TONE beats varying the form, so the energy-aware register
      //    wins for that lead and no shape is assigned.
      //
      // Never both: each claims authority over reply length, and two contradicting
      // length rules in one prompt is how #498's review said drafts get squeezed.
      const toneFirst = postEnergy != null && TONE_FIRST_ENERGIES.has(postEnergy);
      // Splitting the tone-first lane. It used to mean "register, and no shape
      // at all", so every joke/celebration/vent/hot-take lead was drafted in the
      // default length band and the four energies that are the LOUDEST part of
      // the feed were also its most uniform. Now half of them are given a shape
      // drawn only from the shapes that can carry that energy, and the other
      // half keep the register — which still expresses things a shape cannot
      // (HYPE's CAPS, DEADPAN's dryness). The energy HINT is injected either
      // way, so tone mirroring never depends on which side of the split a lead
      // lands on. Register and shape stay mutually exclusive: two length rules
      // in one prompt is how drafts get squeezed.
      const toneFirstShape =
        toneFirst && variety?.enabled
          ? (variety.rng ?? Math.random)() < TONE_FIRST_SHAPE_SHARE
          : false;
      // LIGHT lane: the classifier judged this not substantial-grade but still
      // worth a short warm reaction (a ship, a launch, a personal win) — or it is
      // a watchlist lead whose skip verdict was clamped. Vega used to have no
      // such lane: a lead was either fully drafted or dropped. It reuses the
      // shape machinery rather than a second prompt, minus the shapes that
      // cannot carry a congrats (a bare QUESTION_ONLY is off-register on a win).
      const isLight = lead.classifier_label === "light";
      // NO stance exclusion on Vega, and the reason is the USER prompt, not the
      // system one. SYSTEM_X's output block does ask for three angles, but
      // renderPrompt's closing line asks for "Exactly ONE reply draft (the
      // single best angle)" on BOTH of its branches, and that line is last —
      // so every X prompt is single-draft whichever system prompt it carries.
      // A stance shape governs that one reply, which is exactly what it is for.
      //
      // A previous version of this excluded STANCE_SHAPE_IDS for brand-less
      // orgs on the premise that managed prod has no brand_config. That premise
      // was backwards: Vega's live row carries a 4.5 KB config with a populated
      // qa, so the exclusion never fired in prod, and where it DID fire it
      // removed RIFF and FLAT_DISAGREE — 15% of the rotation, including the only
      // joke shape — from a prompt that was never multi-angle.
      const formVariant =
        variety?.enabled && (!toneFirst || toneFirstShape)
          ? (variety.formVariantRotation ?? xFormVariantRotation).next(variety.rng, [
              ...(isLight ? LIGHT_EXCLUDED_VARIANT_IDS : []),
              // Only on the shaped half of the tone-first split. An ordinary
              // analytical lead keeps the full rotation.
              ...(toneFirstShape ? shapesExcludedForEnergy(postEnergy, X_FORM_VARIANTS) : []),
            ])
          : undefined;
      const shapeBlock = formVariant ? renderAssignedShapeBlock(formVariant) : undefined;
      // OPENING MOVE: varies how the reply STARTS (the register varies tone, the
      // shape varies length — this varies structure). Only for shapes that leave
      // the opener free: the short shapes have no opening distinct from the whole
      // reply, and HOOK_THEN_LINE/OBSERVE_ASK/DETAIL_ZOOM already prescribe their
      // own opener, so a second directive would fight the first. On a lead with
      // no shape at all (the tone-first register lane) there is nothing to
      // conflict with, so the move applies there too.
      const openingMoveBlock =
        variety?.enabled && (!formVariant || SHAPES_WITH_FREE_OPENER.includes(formVariant.id))
          ? renderOpeningMoveBlock(
              pickOpeningMove(
                variety.rng,
                // TWO_FLAT and RUN_ON explicitly forbid a question, so the
                // QUESTION move would order one the shape bans. pickOpeningMove
                // renormalizes over whatever pool it is handed.
                formVariant && SHAPES_BANNING_QUESTIONS.includes(formVariant.id)
                  ? X_OPENING_MOVES.filter((m) => m.id !== "QUESTION")
                  : X_OPENING_MOVES,
              ),
              "reply",
            )
          : undefined;
      // Gen-z SPOKEN REGISTER: on a minority of leads, offer ONE current
      // marker the reply may use once, or drop. Independent of the shape and
      // register lanes because it governs WORD CHOICE, not length or tone, so
      // it can sit alongside either without contradicting it. The rate is the
      // whole design — "don't overdo it, it looks more ai that way" — so this
      // is gated separately from NOELLE_DRAFTER_VARIETY's on/off and defaults
      // to 22%. A rate of 0 emits no block and leaves the prompt unchanged.
