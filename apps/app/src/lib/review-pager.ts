/**
 * Position + neighbors of one approval within the ordered pending queue, for
 * the detail page's "Lead N of M" pager. Pure: the page fetches the ordered
 * pending list (listPendingApprovalsForOrg), maps it to approval ids, and asks
 * where the current lead sits.
 *
 * `index === -1` means the current approval isn't in the pending queue (e.g.
 * an already-actioned row reached by deeplink) — callers hide the pager.
 */
export interface PagerNeighbors {
  /** 0-based position in the queue, or -1 if absent. */
  index: number;
  /** Total pending leads in the queue. */
  total: number;
  prevId: string | null;
  nextId: string | null;
}

export function pagerNeighbors(ids: string[], currentId: string): PagerNeighbors {
  const index = ids.indexOf(currentId);
  return {
    index,
    total: ids.length,
    prevId: index > 0 ? ids[index - 1] : null,
    nextId: index >= 0 && index < ids.length - 1 ? ids[index + 1] : null,
  };
}

/**
 * Which href an arrow key should navigate to (←/→), or null to ignore the key.
 * Pure so the ReviewPager component stays a thin shell over a tested mapping.
 */
export function arrowTarget(
  key: string,
  prevHref: string | null,
  nextHref: string | null,
): string | null {
  if (key === "ArrowLeft") return prevHref;
  if (key === "ArrowRight") return nextHref;
  return null;
}
