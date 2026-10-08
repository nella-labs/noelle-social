/**
 * Per-worker model routing resolver.
 *
 * Shape stored in `noelle.agent_instances.model_overrides`:
 *
 *   {
 *     "primary":  { engine, model }?,         // legacy default (chat + drafter)
 *     "fallback": { engine, model } | null?,  // legacy default
 *     "workers": {                            // new — per-worker overrides
 *       "classifier": { primary, fallback? } | null,
 *       "drafter":    { primary, fallback? } | null
 *     }?
 *   }
 *
 * Backward compat: rows persisted before per-worker pickers landed only
 * carry `primary`/`fallback`. Those keep flowing to the drafter via the
 * fallthrough below. New rows can drop `primary`/`fallback` entirely if
 * every worker has its own override.
 *
 * Resolver precedence per worker:
 *   1. `workers.<id>.primary` if set + a `lookupCatalogEntry` recognises it
 *   2. legacy `primary` (for the drafter / chat path)
 *   3. `defaults[<id>]` — hardcoded baseline
 *
 * Preview-status handles are swapped to their nearest ready counterpart at
 * call time via `effectiveHandle` — the operator's intent stays persisted
 * but the runtime never tries to invoke an un-wired backend.
 */

import type { EngineHandle, ModelRouting, WorkerId } from "./types.js";
import { effectiveHandle, lookupCatalogEntry } from "./modelCatalog.js";

/** Per-worker hardcoded defaults. Used when no override + no legacy primary. */
export const WORKER_DEFAULTS: Record<WorkerId, ModelRouting | null> = {
  // No LLM call — discovery just polls X / public-search APIs.
  discovery: null,
  classifier: {
    primary: { engine: "bedrock", model: "claude-haiku-4-5" },
    fallback: { engine: "bedrock", model: "claude-sonnet-4-6" },
  },
  drafter: {
    primary: { engine: "bedrock", model: "claude-sonnet-4-6" },
    fallback: { engine: "bedrock", model: "claude-opus-4-6" },
  },
  // No LLM call — send just posts to X via the user's OAuth token.
  send: null,
};

export type PersistedModelOverrides = {
  primary?: EngineHandle;
  fallback?: EngineHandle | null;
  workers?: Partial<
    Record<
      WorkerId,
      {
        primary?: EngineHandle;
        fallback?: EngineHandle | null;
      } | null
    >
  >;
};

function isValidHandle(value: unknown): value is EngineHandle {
  if (!value || typeof value !== "object") return false;
  const v = value as { engine?: unknown; model?: unknown };
  if (typeof v.engine !== "string" || typeof v.model !== "string") return false;
  return lookupCatalogEntry(v.engine, v.model) != null;
}

/**
 * Resolve the routing for a specific worker on a specific instance.
 *
 * Returns `null` for workers that don't call LLMs (discovery, send) so
 * callers can early-out without inventing a fake routing. For LLM workers
 * the return is always a valid `ModelRouting` — preview handles are
 * collapsed to ready ones via `effectiveHandle` so the caller can route
 * directly to the backend without checking status.
 */
export function resolveWorkerRouting(
  workerId: WorkerId,
  overrides: PersistedModelOverrides | null | undefined,
): ModelRouting | null {
  const defaults = WORKER_DEFAULTS[workerId];
  if (defaults == null) return null;

  const workerOverride = overrides?.workers?.[workerId] ?? null;
  const candidatePrimary = workerOverride?.primary ?? overrides?.primary;
  const candidateFallback =
    workerOverride && "fallback" in workerOverride
      ? workerOverride.fallback
      : overrides?.fallback;

  const primary = isValidHandle(candidatePrimary)
    ? effectiveHandle(candidatePrimary)
    : defaults.primary;

  // Explicit `null` means "fail on primary error". An invalid handle
  // falls back to the worker default so a broken JSON shape doesn't
  // quietly upgrade to "fail on any 5xx".
  let fallback: EngineHandle | undefined;
  if (candidateFallback === null) {
    fallback = undefined;
  } else if (isValidHandle(candidateFallback)) {
    fallback = effectiveHandle(candidateFallback);
  } else {
    fallback = defaults.fallback;
  }

  return fallback ? { primary, fallback } : { primary };
}

/**
 * Convenience for callers that need the *intended* (pre-effectiveHandle)
 * routing for display purposes — e.g. the agent detail page showing the
 * exact handle the operator picked, including its "preview" status.
 */
export function resolveWorkerRoutingDisplay(
  workerId: WorkerId,
  overrides: PersistedModelOverrides | null | undefined,
): ModelRouting | null {
  const defaults = WORKER_DEFAULTS[workerId];
  if (defaults == null) return null;

  const workerOverride = overrides?.workers?.[workerId] ?? null;
  const candidatePrimary = workerOverride?.primary ?? overrides?.primary;
  const candidateFallback =
    workerOverride && "fallback" in workerOverride
      ? workerOverride.fallback
      : overrides?.fallback;

  const primary = isValidHandle(candidatePrimary)
    ? candidatePrimary
    : defaults.primary;

  let fallback: EngineHandle | undefined;
  if (candidateFallback === null) {
    fallback = undefined;
  } else if (isValidHandle(candidateFallback)) {
    fallback = candidateFallback;
  } else {
    fallback = defaults.fallback;
  }

  return fallback ? { primary, fallback } : { primary };
}
