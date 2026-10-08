/**
 * Per-instance, per-mode rotation cursors for the discovery source ring.
 *
 * The cursor must be keyed by ring SHAPE, not just instance: full-mode ticks
 * iterate (targeting ∪ people) + keywords while watchlist-only ticks iterate
 * people only, and the tick re-normalizes the stored value modulo ITS OWN
 * ring length before writing back. A single shared cursor would be clamped
 * into [0, peopleCount) by every watchlist-only tick — and watchlist-only
 * ticks are routine (paused instance, goal reached, pending approvals or
 * lead backlog at cap) — so full-mode rotation would forever restart near
 * the head, starving the ring tail + keyword lane all over again.
 *
 * In-memory, module-lifetime state like the repoll gates: a worker restart
 * re-enters each ring at the head, costing at most one uneven pass.
 */
export interface SourceCursor {
  get(): number;
  set(v: number): void;
}

export type DiscoveryTickMode = "full" | "watchlist";

export interface SourceCursorRegistry {
  /**
   * `shard` scopes the cursor to ONE shard of a concurrent discovery fan-out.
   * Each shard walks its own round-robin slice of the source ring, so sharing a
   * cursor would make shard N resume at another shard's offset and re-poll the
   * wrong sources. Omitted (the unsharded path) keeps the original key, so an
   * existing in-memory cursor is not orphaned when concurrency is left at 1.
   */
  for(instanceId: string, mode: DiscoveryTickMode, shard?: number): SourceCursor;
}

export function createSourceCursorRegistry(): SourceCursorRegistry {
  const cursors = new Map<string, number>();
  return {
    for(instanceId, mode, shard) {
      const key = shard == null ? `${instanceId}:${mode}` : `${instanceId}:${mode}:s${shard}`;
      return {
        get: () => cursors.get(key) ?? 0,
        set: (v) => {
          cursors.set(key, v);
        },
      };
    },
  };
}
