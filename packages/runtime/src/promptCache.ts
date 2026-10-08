// Prompt-caching helpers (PR-E, theme T7-token-caching). Two opt-in, pure,
// deterministic mechanisms for caching the static system prefix of a drafter
// call on the Anthropic/Bedrock backends so it is not re-billed on every draft
// + every verify-regenerate:
//
//   1. PREFIX SPLIT (NOELLE_PROMPT_CACHE_ENABLED): the caller computes the exact
//      char length of the stable system prefix and passes it as
//      `systemCachePrefixLen`; toCachedSystemBlocks splits the system into a
//      cached prefix block + an uncached suffix block. Used by the LinkedIn
//      drafter, whose per-lead mission/person/style suffix follows a large,
//      unchanging base.
//   2. WHOLE-SYSTEM (NOELLE_PROMPT_CACHE_SYSTEM): for buckets whose ENTIRE
//      system prompt is byte-stable across calls (the drafter buckets),
//      shouldCacheSystem gates caching the whole system block.
//
// Both DEFAULT OFF and both fail-open: on any out-of-range input, or on any
// runtime rejection of the cache_control block by the provider (handled in the
// backends), the request degrades to a byte-identical no-cache call. Neither
// helper reads the clock or the environment — env gating lives only in
// callAgentModel at the impure boundary — so both stay unit-testable per repo
// rule 4.

export interface CacheableTextBlock {
  type: "text";
  text: string;
  cache_control?: { type: "ephemeral" };
}

/**
 * Split a system prompt into a cacheable prefix block + an uncached suffix
 * block. Pure + deterministic (no env, no Date.now). Returns the plain string
 * UNCHANGED (fail-open, byte-identical request) when caching is not applicable:
 * prefixLen missing / <= 0 / > system.length, or system empty. The caller
 * guarantees prefixLen indexes a real byte-prefix of `system`.
 *
 * INVARIANT: the returned blocks always concatenate back to the exact original
 * system string (see promptCache.test.ts), so no prompt bytes are ever dropped
 * or reordered — the model always sees the full instruction set. A wrong
 * prefixLen only changes the cache breakpoint (cache hit-rate), never output.
 */
export function toCachedSystemBlocks(
  system: string,
  prefixLen: number | undefined,
): string | CacheableTextBlock[] {
  if (!prefixLen || prefixLen <= 0 || prefixLen > system.length) return system;
  const prefix = system.slice(0, prefixLen);
  const blocks: CacheableTextBlock[] = [
    { type: "text", text: prefix, cache_control: { type: "ephemeral" } },
  ];
  const suffix = system.slice(prefixLen);
  if (suffix.length > 0) blocks.push({ type: "text", text: suffix });
  return blocks;
}

/**
 * Buckets whose ENTIRE system prompt is byte-stable across calls, so the whole
 * system block is a valid cache breakpoint. The three drafter buckets qualify;
 * classifier/profiler/send/feeder/ideation do not (their system varies per
 * call or is small). Frozen set — the source of truth for shouldCacheSystem.
 */
export const CACHEABLE_SYSTEM_BUCKETS: ReadonlySet<string> = new Set([
  "drafter",
  "drafter-codex",
  "drafter-verify",
]);

/**
 * Decide whether the whole-system cache breakpoint should be attached for a
 * given bucket. PURE. `flagVal` is the raw NOELLE_PROMPT_CACHE_SYSTEM value
 * (undefined when unset). Fail-closed: caching engages ONLY when the flag is
 * exactly the string "1" AND the bucket is one of the cacheable drafter
 * buckets. Any other value, unset, or an unknown bucket → false (no marker,
 * byte-identical request).
 */
export function shouldCacheSystem(bucket: string, flagVal: string | undefined): boolean {
  if (flagVal !== "1") return false;
  return CACHEABLE_SYSTEM_BUCKETS.has(bucket);
}

/**
 * Fold the cached-token buckets into a single full-price input count so spend
 * is NEVER under-counted when a call is served from cache. PURE. Accepts null
 * on every field because the Anthropic SDK 0.69.0 `Usage` type declares
 * cache_creation_input_tokens / cache_read_input_tokens as `number | null`;
 * `?? 0` normalizes null and undefined identically. When no caching is in play
 * (read/creation absent or 0) this returns exactly `input_tokens`, so existing
 * spend accounting is unchanged.
 */
export function effectiveInputTokens(u: {
  input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
}): number {
  return (
    (u.input_tokens ?? 0) +
    (u.cache_read_input_tokens ?? 0) +
    (u.cache_creation_input_tokens ?? 0)
  );
}

/** Fold validated Anthropic cache counts; only omitted optional fields imply zero. */
export function reportedAnthropicUsage(value: unknown): TokenUsage {
  const usage = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
  const input = usage.input_tokens;
  const read = Object.hasOwn(usage, "cache_read_input_tokens") ? usage.cache_read_input_tokens : 0;
  const creation = Object.hasOwn(usage, "cache_creation_input_tokens") ? usage.cache_creation_input_tokens : 0;
  const total = isAccountingInteger(input) && isAccountingInteger(read) && isAccountingInteger(creation)
    ? effectiveInputTokens({ input_tokens: input, cache_read_input_tokens: read, cache_creation_input_tokens: creation })
    : undefined;
  return normalizeTokenUsage(total, usage.output_tokens);
}

/**
 * Build the backend `system` argument, applying whichever cache mechanism the
 * call requested. PURE + deterministic. Precedence: a prefix-split length wins
 * over whole-system (it is a strict superset — caches the stable prefix, leaves
 * the rest uncached). Returns the plain string when neither applies OR when the
 * prefix split is out of range (toCachedSystemBlocks fails open). The returned
 * value always reconstructs the exact original `system` bytes.
 */
export function resolveCachedSystem(args: {
  system: string;
  systemCachePrefixLen?: number;
  cacheSystem?: boolean;
}): string | CacheableTextBlock[] {
  if (typeof args.systemCachePrefixLen === "number") {
    return toCachedSystemBlocks(args.system, args.systemCachePrefixLen);
  }
  if (args.cacheSystem && args.system.length > 0) {
    return [{ type: "text", text: args.system, cache_control: { type: "ephemeral" } }];
  }
  return args.system;
}

/**
 * True when an error looks attributable to the cache_control breakpoint being
 * rejected at call time (model/region that doesn't support caching, malformed
 * system block, etc). Used by the caching-capable backends to fail OPEN: catch
 * such an error and retry ONCE with the plain-string system, so a runtime
 * rejection degrades to a byte-identical no-cache call instead of breaking the
 * draft. A reported HTTP status must be a validation failure; authentication,
 * throttling and server failures never authorize another model request.
 */
export function isCacheControlError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  if ("status" in err && err.status !== undefined && err.status !== 400 && err.status !== 422) return false;
  const msg =
    "message" in err && typeof (err as { message: unknown }).message === "string"
      ? (err as { message: string }).message.toLowerCase()
      : "";
  return msg.includes("cache");
}
import type { TokenUsage } from "./callAgentModel.js";
import { isAccountingInteger, normalizeTokenUsage } from "./callCostAccounting.js";
