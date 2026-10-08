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

