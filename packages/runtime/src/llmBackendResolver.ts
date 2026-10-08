/**
 * Per-org LLM backend resolver.
 *
 * The global "AWS Bedrock ↔ Claude" agent-model switch lives on
 * noelle.organizations.llm_backend ('aws' | 'claude'), written by the admin UI
 * (apps/app) and read here by callAgentModel to decide, per call, whether to
 * rewrite a `bedrock` PRIMARY handle to the local `claude-cli` subscription.
 *
 * This module is the single home for that read. It:
 *   - runs one parametrised SELECT against the app's postgres.js client,
 *   - DEFAULTS to "claude" on a null value, a missing row, or ANY thrown error
 *     (fail toward the current claude-cli behavior — the cost-saving path),
 *   - caches the answer per orgId with a short TTL so the per-call lookup isn't
 *     a DB round-trip on every single LLM call in a tight worker loop.
 *
 * The client is modelled structurally (a tagged-template function returning
 * rows) so it stays portable — `@noelle/runtime` keeps zero dep on `postgres`
 * — and is trivially faked in tests. postgres.js `Sql` satisfies it directly.
 */

export type LlmBackend = "aws" | "claude";

/** Row shape this resolver reads from noelle.organizations. */
export type LlmBackendRow = { llm_backend?: string | null };

/**
 * Minimal structural shape of a tagged-template SQL client: call it as a
 * template literal and get back a thenable of rows. postgres.js's `Sql` is a
 * single heavily-overloaded generic call signature (its `Helper` return path
 * for the fragment/identifier forms has a private `then`, so the concrete `Sql`
 * is NOT directly assignable to this simpler shape) — the worker passes its
 * `Sql` through a one-line cast at the wiring boundary. Kept here so
 * `@noelle/runtime` stays free of a hard `postgres` dependency and the resolver
 * is trivially faked in tests.
 */
export type LlmBackendQuery = (
  strings: TemplateStringsArray,
  ...values: readonly unknown[]
) => PromiseLike<ReadonlyArray<LlmBackendRow>>;

export type MakeLlmBackendResolverOptions = {
  /** Per-org cache TTL in ms. Default 30s. */
  ttlMs?: number;
};

const DEFAULT_TTL_MS = 30_000;
const DEFAULT_BACKEND: LlmBackend = "claude";

function normalize(value: unknown): LlmBackend {
  return value === "aws" ? "aws" : DEFAULT_BACKEND;
}

/**
 * Build a resolver `(orgId) => Promise<"aws" | "claude">` backed by the app's
 * postgres.js client, with a per-org TTL cache. Wire it into CallAgentModelDeps
 * as `getLlmBackend`.
 */
export function makeLlmBackendResolver(
  query: LlmBackendQuery,
  opts?: MakeLlmBackendResolverOptions,
): (orgId: string) => Promise<LlmBackend> {
  const ttlMs = opts?.ttlMs ?? DEFAULT_TTL_MS;
  // Cache the in-flight/resolved value per orgId. We cache the resolved
  // backend (not the promise) keyed by an expiry so a transient error doesn't
  // get pinned for the whole TTL beyond the single call that hit it.
  const cache = new Map<string, { value: LlmBackend; expiresAt: number }>();

  return async function getLlmBackend(orgId: string): Promise<LlmBackend> {
    const now = Date.now();
    const hit = cache.get(orgId);
    if (hit && hit.expiresAt > now) return hit.value;

    let value: LlmBackend;
    try {
      const rows = await query`
        select llm_backend from noelle.organizations where id = ${orgId} limit 1
      `;
      const row = rows[0];
      // Missing row → undefined → default. Present but null → default.
      value = row ? normalize(row.llm_backend) : DEFAULT_BACKEND;
    } catch {
      // Fail toward current behavior. Don't cache errors long: use a short TTL
      // window via the same map so we retry soon, but still avoid hammering the
      // DB if it's down mid-loop.
      value = DEFAULT_BACKEND;
    }

    cache.set(orgId, { value, expiresAt: now + ttlMs });
    return value;
  };
}
