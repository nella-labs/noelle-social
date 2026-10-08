import type { EngineHandle, ModelRouting } from "@noelle/runtime";
import type { ActiveInstance } from "./activation.js";

export type { ModelRouting };

/**
 * Default routing for the LinkedIn intern. Mirrors the X intern: Bedrock
 * primary/fallback (the engine wired in @noelle/runtime). Per-instance overrides
 * set via the dashboard config page are merged in by `linkedinInternRouting()`.
 * On the self-host Lima VM, Bedrock can flake; the operator can set
 * model_overrides to a Vertex handle there (see the self-host targeting note).
 */
// Primary is SONNET: the everyday draft model. Opus is reserved for genuinely
// high-engagement leads via `opusOverrideRouting` (reaction-tiered) — it is NOT
// forced on every watchlist lead, which was ~6x the cost for no quality win.
// Opus stays as the failover so a rare Sonnet 5xx still yields a strong draft.
// Set the model HERE, not in the per-instance model_overrides DB column — the
// dashboard agent page renders model_overrides as a flat string map and
// React-crashes on the {engine,model} object shape the worker expects.
const DEFAULT_ROUTING: ModelRouting = {
  primary: { engine: "bedrock", model: "claude-sonnet-4-6" },
  fallback: { engine: "bedrock", model: "claude-opus-4-6" },
};

// The verifier/judge SCORES drafts (voice/grounding/format) — it does not write
// them — so it runs on the cheapest capable model (Haiku), never the drafting
// model. Judges inheriting the Opus drafting routing were the single biggest
// chunk of drafter LLM spend (a judge fires once or more per draft).
const JUDGE_ROUTING: ModelRouting = {
  primary: { engine: "bedrock", model: "claude-haiku-4-5" },
};

/** Routing for the post-draft verifier/judge calls. Always Haiku — see above. */
export function judgeRouting(): ModelRouting {
  return JUDGE_ROUTING;
}

const ALLOWED_ENGINES = new Set(["bedrock"]);
const ALLOWED_BEDROCK_MODELS = new Set([
  "claude-haiku-4-5",
  "claude-sonnet-4-6",
  "claude-opus-4-6",
]);

function isValidHandle(value: unknown): value is EngineHandle {
  if (!value || typeof value !== "object") return false;
  const v = value as { engine?: unknown; model?: unknown };
  if (typeof v.engine !== "string" || typeof v.model !== "string") return false;
  if (!ALLOWED_ENGINES.has(v.engine)) return false;
  if (v.engine === "bedrock" && !ALLOWED_BEDROCK_MODELS.has(v.model)) return false;
  return true;
}

/**
 * Build the routing for a specific linkedin_intern instance. Merges any
 * `model_overrides` set on the row over the default routing. Invalid / unknown
 * handles in the override are silently ignored — the default wins.
 */
export function linkedinInternRouting(
  instance?: Pick<ActiveInstance, "model_overrides">,
): ModelRouting {
  if (!instance?.model_overrides) return DEFAULT_ROUTING;

  const overrides = instance.model_overrides as {
    primary?: unknown;
    fallback?: unknown;
  };

  const primary = isValidHandle(overrides.primary)
    ? overrides.primary
    : DEFAULT_ROUTING.primary;

  // Explicit `null` means "no fallback, fail on primary error". An invalid
  // handle falls back to the default fallback.
  let fallback: EngineHandle | undefined;
  if (overrides.fallback === null) {
    fallback = undefined;
  } else if (isValidHandle(overrides.fallback)) {
    fallback = overrides.fallback;
  } else {
    fallback = DEFAULT_ROUTING.fallback;
  }

  return { primary, fallback };
}

/**
 * The Bedrock Opus handle the drafter overrides to for a high-engagement lead.
 * `claude-opus-4-6` is the top Opus the noelle-agents AWS account has access to
 * (see packages/runtime/src/bedrockBackend.ts) and is the only Opus in the
 * Noelle bedrock model union. Overridable via NOELLE_DRAFTER_OPUS_MODEL.
 */
export const DEFAULT_OPUS_MODEL = "claude-opus-4-6";

/**
 * Build the routing for ONE high-engagement lead's draft call: force the primary
 * engine to Opus, but keep the instance's normal routing primary as the fallback
 * so a missing/unavailable Opus engine gracefully falls back to the regular
 * model rather than blocking the draft. The base routing is whatever
 * `linkedinInternRouting(instance)` produced (default or per-instance override).
 *
 * Only the Bedrock engine maps an Opus handle (and Opus lives only in the
 * Bedrock model union), so the override always targets `engine: "bedrock"`. When
 * `opusModel` isn't a known Bedrock Opus handle, we still pass it through (the
 * backend maps unknown handles 1:1 and a 4xx triggers the fallback), so an env
 * override to a future Opus id keeps working without a code change.
 */
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
