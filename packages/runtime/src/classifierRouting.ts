// Consolidated from three copies whose executable code was identical:
//   apps/x-intern/src/lib/classifier-routing.ts        (Vega)
//   apps/linkedin-intern/src/lib/classifier-routing.ts (Lyra)
//   apps/reddit-intern/src/lib/classifier-routing.ts   (Orion)
//
// LinkedIn and Reddit were byte-identical to each other (same md5). The X copy
// differed ONLY in JSDoc prose/reflow — comment-stripped, all three matched
// byte for byte. There was nothing platform-specific to parameterise: no copy
// branched on platform, threshold, engine allow-list, or model handle, so no
// intern's routing changes by sharing this. Which backend actually runs stays
// entirely in `resolveWorkerRouting` + `noelle.agent_instances.model_overrides`
// (per-instance, per-worker), so this extraction cannot move an intern onto a
// paid backend.
//
// The LinkedIn copy's own claim that it was "Identical to the x-intern's
// classifier-routing" was TRUE at code level, and is now structurally enforced
// instead of asserted in a comment.
//
// Imports `resolveWorkerRouting` relatively (./workerRouting.js) rather than
// through the "@noelle/runtime" barrel the app copies used — same function, but
// a package must not self-reference by name.

import { resolveWorkerRouting, type PersistedModelOverrides } from "./workerRouting.js";

/**
 * Resolve the model handle the classifier should call.
 *
 * The classifier engine runs through the Vertex AI Gemini backend
 * (`createVertexBackend`), which only speaks Gemini. The runtime's
 * `resolveWorkerRouting` returns an EngineHandle for the `classifier` worker;
 * we honour vertex+gemini picks and fall back to the engine default for any
 * non-Gemini engine (Bedrock Claude, Anthropic-direct), logging that fact so
 * it shows up in Cloud Logging.
 *
 * Returns `{ model, fellBack }`:
 *   - `model` is the dashed Gemini handle (e.g. "gemini-2-5-flash") to pass to
 *     `createClassifier`; the Vertex backend maps it to the dotted API name.
 *     `undefined` means use the engine's default (Gemini Flash).
 *   - `fellBack` is true when the operator picked a non-Gemini engine, letting
 *     the worker log the fallback exactly once per tick.
 */
export function resolveClassifierModel(
  overrides: unknown,
): { model: string | undefined; fellBack: boolean } {
  const routing = resolveWorkerRouting(
    "classifier",
    overrides as PersistedModelOverrides | null,
  );
  if (!routing) return { model: undefined, fellBack: false };
  const primary = routing.primary;
  if (primary.engine === "vertex" && primary.model.startsWith("gemini")) {
    // Pass the dashed catalog handle straight through — createVertexBackend
    // maps "gemini-2-5-flash" → "gemini-2.5-flash" at call time.
    return { model: primary.model, fellBack: false };
  }
  // Bedrock / Anthropic picks → fall back to the engine default and tell
  // the caller to log.
  return { model: undefined, fellBack: true };
}
