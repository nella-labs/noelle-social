import { shardRoundRobin } from "@noelle/runtime";
import { createApifyXClient, type ApifyXClient } from "@noelle/x-apify";
import { listApifyTokens, clearApifyTokenExhausted } from "./connections-db.js";
import { createRotatingApifyClient, type RotatingTokenCandidate } from "./apify-rotating.js";
import { createApifyResolver, handleTokenFatal, type ApifyHandle, type ResolverDeps } from "./apify-resolver.js";

/**
 * SHARDED resolver: N handles whose token pools are DISJOINT.
 *
 * `createApifyResolver` below returns ONE handle whose rotating client fails
 * over across the whole pool sequentially — correct when tokens are scarce, but
 * it means one tick can only ever have one Apify run in flight. With a real pool
 * (the operator adds tokens daily) the bottleneck stops being supply and starts
 * being that serialisation.
 *
 * The tokens are round-robined into `shards` groups, so no two shards can ever
 * hold the same token at the same moment — that is the property that makes
 * concurrent runs safe rather than a way to get one token rate-limited N times
 * over. Each shard still gets a full rotating client over ITS group, so
 * within-shard failover is unchanged.
 *
 * Returns at most `min(shards, availableTokens)` handles: with 3 available
 * tokens and shards=8 you get 3, never 8 sharing. Returns [] when the pool has
 * nothing available, so the caller can page exactly as before. The single-token
 * env/SM fallback is deliberately NOT sharded — one token cannot be split.
 */
export function createApifyShardResolver(
  deps: ResolverDeps,
): (orgId: string, shards: number) => Promise<ApifyHandle[]> {
  const single = createApifyResolver(deps);
  const buildClient = (token: string): ApifyXClient =>
    createApifyXClient({
      token,
      ...(deps.actorId ? { actorId: deps.actorId } : {}),
      ...(deps.apifyTimeoutMs ? { timeoutMs: deps.apifyTimeoutMs } : {}),
    });

  return async (orgId: string, shards: number): Promise<ApifyHandle[]> => {
    const want = Number.isFinite(shards) ? Math.max(1, Math.floor(shards)) : 1;
    // One shard requested ⇒ take the ordinary path verbatim, so the default
    // configuration is byte-identical to before this existed.
    if (want === 1) {
      const one = await single(orgId);
      return one ? [one] : [];
    }

    const dbTokens = await listApifyTokens(deps.sql, orgId).catch(() => []);
    // No DB pool ⇒ the env/SM fallback, which is a single token and cannot shard.
    if (dbTokens.length === 0) {
      const one = await single(orgId);
      return one ? [one] : [];
    }

    const available: RotatingTokenCandidate[] = dbTokens
      .filter((t) => t.available)
      .map((t) => ({ credentialId: t.credentialId, token: t.token, wasExhausted: t.wasExhausted }));

    // Nothing usable: hand back ONE handle over the empty candidate set so the
    // caller's first call raises "all N exhausted" and pages, exactly as the
    // unsharded path does. Splitting an empty pool would page N times instead.
    if (available.length === 0) {
      const one = await single(orgId);
      return one ? [one] : [];
    }

    const groups = shardRoundRobin(available, Math.min(want, available.length));
    return groups
      .filter((g) => g.length > 0)
      .map((candidates) => ({
        client: createRotatingApifyClient({
          candidates,
          // This shard's OWN size, not the global pool: a shard must raise
          // "exhausted" when ITS tokens are spent. The caller decides whether
          // that means the whole pool is dead (every shard exhausted) or just
          // this slice (the others keep going).
          totalCount: candidates.length,
          buildClient,
          onTokenFatal: (id, status, token) => {
            void handleTokenFatal(deps, id, status, token, orgId);
          },
          onRecovered: (id) => {
            void clearApifyTokenExhausted(deps.sql, id).catch(() => {});
          },
          log: deps.log,
        }),
        // A shard spans several credentials, so there is no single id to
        // attribute spend to; the rotating client reports the live one per call.
        credentialId: candidates[0]?.credentialId ?? null,
      }));
  };
}
