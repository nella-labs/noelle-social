import {
  resolveWorkerRouting,
  type EngineHandle,
  type ModelRouting,
  type PersistedModelOverrides,
} from "@noelle/runtime";
import type { ActiveInstance } from "./activation.js";

/**
 * Drafter's documented default routing. Only used as a total-function guard —
 * `resolveWorkerRouting("drafter", …)` already falls back to the drafter's
 * `WORKER_DEFAULTS`, so this branch is unreachable in practice; it exists so
 * the return type stays `ModelRouting` (never null) for the legacy/test call
 * sites that invoke `xInternRouting()` with no instance.
 */
const DEFAULT_ROUTING: ModelRouting = {
  primary: { engine: "bedrock", model: "claude-sonnet-4-6" },
  fallback: { engine: "bedrock", model: "claude-opus-4-6" },
};

// The verifier/judge SCORES drafts (voice/grounding/relevance/format) — it
// does not write them and its verdict does not gate the queue (see
// docs/grounded-drafting.md) — so it runs on the cheapest capable model
// (Haiku), never the Sonnet/Opus drafting model. Mirrors the LinkedIn
// intern's judgeRouting() (apps/linkedin-intern/src/lib/routing.ts). No
// fallback: a judge 5xx fails open in draftVerifier (draft still queued for
// human approval), so a fallback tier buys nothing.
const JUDGE_ROUTING: ModelRouting = {
  primary: { engine: "bedrock", model: "claude-haiku-4-5" },
};

/** Routing for the post-draft verifier/judge calls. Always Haiku — see above. */
export function judgeRouting(): ModelRouting {
  return JUDGE_ROUTING;
}

/**
 * Build the routing the X intern's drafter (and profiler) runs through for a
 * specific instance.
 *
 * Delegates to the shared per-worker resolver so the dashboard's *drafter*
 * model picker (`model_overrides.workers.drafter`) is actually honored — not
 * just the legacy top-level `primary`/`fallback` — and so any catalog engine
 * the operator picks (bedrock / vertex / codex) is accepted instead of being
 * silently rejected and reset to the bedrock default. Preview-status handles
 * are collapsed to their ready counterpart by the resolver.
 *
 * Calling `xInternRouting()` with no args (or an instance with no overrides)
 * yields the drafter's documented default — useful for code paths without an
 * instance row in scope (legacy call sites, tests).
 */
export function xInternRouting(
  instance?: Pick<ActiveInstance, "model_overrides">,
): ModelRouting {
  const overrides = (instance?.model_overrides ??
    null) as PersistedModelOverrides | null;
  return resolveWorkerRouting("drafter", overrides) ?? DEFAULT_ROUTING;
}

/**
 * Build the routing for ONE high-engagement lead's draft call: force the primary
 * engine to Opus, but keep the instance's normal routing primary as the fallback
 * so a missing/unavailable Opus engine gracefully falls back to the regular
 * model rather than blocking the draft. The base routing is whatever
 * `xInternRouting(instance)` produced (default or per-instance override).
 *
 * Only the Bedrock engine maps an Opus handle (and Opus lives only in the
 * Bedrock model union), so the override always targets `engine: "bedrock"`. When
 * `opusModel` isn't a known Bedrock Opus handle, we still pass it through (the
 * backend maps unknown handles 1:1 and a 4xx triggers the fallback), so an env
 * override to a future Opus id keeps working without a code change.
 */
/** Bedrock Opus handle used when a high-engagement lead escalates. */
export const DEFAULT_OPUS_MODEL = "claude-opus-4-6";

export function opusOverrideRouting(
  base: ModelRouting,
  opusModel: string = DEFAULT_OPUS_MODEL,
): ModelRouting {
  // Narrow to the Bedrock branch of EngineHandle so the model type is the bedrock
  // model union. `opusModel` is a configurable string (an env override could name
  // a future Opus id the backend maps 1:1), so we assert it into that branch.
  const bedrockOpus = {
    engine: "bedrock",
    model: opusModel,
  } as Extract<EngineHandle, { engine: "bedrock" }>;
  return {
    primary: bedrockOpus,
    // Fall back to the base routing's primary (normal sonnet model) if Opus is
    // unavailable, so a high-engagement lead is never left undrafted.
    fallback: base.primary,
  };
}
