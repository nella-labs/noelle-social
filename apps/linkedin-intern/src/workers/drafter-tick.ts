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
