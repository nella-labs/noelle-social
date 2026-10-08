/**
 * Organization-scoped voice retrieval through the configured Nella backend.
 * Active vault rows map org IDs to workspace IDs. Missing, inactive or
 * unavailable vaults yield no anchors. Cache lifetime follows the resolver
 * instance; construct one per request to refresh the workspace lookup.
 */

import type { Hit, NellaClient } from "./nellaClient.js";
import type { QueryExecutor } from "./tenancy.js";

export interface VaultLookup {
  nella_workspace_id: string;
  status?: string;
}

export interface VaultResolver {
  getAnchors(args: {
    orgId: string;
    query: string;
    topK?: number;
    filters?: { language?: string; filePattern?: string };
  }): Promise<Hit[]>;

  /**
   * Lower-level: return the raw lookup row (or null) for an org.
   * Exposed so callers like the dashboard vault page can read the
   * workspace id without making a Nella round-trip.
   */
  resolve(orgId: string): Promise<VaultLookup | null>;

  /** Test-only: drop the in-memory workspace cache. */
  __resetCache(): void;
}

export interface VaultResolverDeps {
  db: QueryExecutor;
  nella: NellaClient;
  defaultTopK?: number;
}

export function createVaultResolver(deps: VaultResolverDeps): VaultResolver {
  const cache = new Map<string, VaultLookup | null>();
  const defaultTopK = deps.defaultTopK ?? 8;

  async function resolve(orgId: string): Promise<VaultLookup | null> {
    if (cache.has(orgId)) return cache.get(orgId) ?? null;
    const rows = (await deps.db(
      `select nella_workspace_id, status from noelle.vaults where org_id = $1 limit 1`,
      [orgId],
    )) as ReadonlyArray<{ nella_workspace_id: string; status?: string }>;
    const row = rows[0];
    let lookup: VaultLookup | null = null;
    if (row) {
      lookup = { nella_workspace_id: row.nella_workspace_id };
      if (row.status !== undefined) lookup.status = row.status;
    }
    cache.set(orgId, lookup);
    return lookup;
  }

  async function getAnchors(args: {
    orgId: string;
    query: string;
    topK?: number;
    filters?: { language?: string; filePattern?: string };
  }): Promise<Hit[]> {
    const lookup = await resolve(args.orgId);
    if (!lookup) return [];
    if (lookup.status && lookup.status !== "active") return [];

    try {
      return await deps.nella.searchContext({
        workspace: lookup.nella_workspace_id,
        query: args.query,
        topK: args.topK ?? defaultTopK,
        ...(args.filters ? { filters: args.filters } : {}),
      });
    } catch {
      return [];
    }
  }

  return {
    getAnchors,
    resolve,
    __resetCache() {
      cache.clear();
    },
  };
}
