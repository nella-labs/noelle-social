import type { Sql } from "postgres";
import type { WatchlistObjectiveKind } from "@noelle/contracts";

export interface Watchlist {
  handles: string[];
  keywords: string[];
}

export async function getWatchlist(sql: Sql, instanceId: string): Promise<Watchlist> {
  const rows = await sql<{ kind: "handle" | "keyword"; value: string }[]>`
    select kind, value
    from noelle.x_watchlist
    where agent_instance_id = ${instanceId}
    order by created_at asc
  `;
  return {
    handles: rows.filter((r) => r.kind === "handle").map((r) => r.value),
    keywords: rows.filter((r) => r.kind === "keyword").map((r) => r.value),
  };
}

export interface WatchlistPerson {
  /** @-stripped, lowercased X handle. */
  handle: string;
  /**
   * ISO timestamp the person was added — posts before this are not prioritized.
   * Normalised to an ISO STRING in getWatchlistPeople: postgres.js hands back a
   * timestamptz as a JS Date, and letting that leak made `Date > isoString`
   * comparisons silently false with no type error to catch it.
   */
  addedAt: string;
}

/**
 * People the intern must always reply to (noelle.x_watchlist_people). Every new
 * post from one of these handles (posted_at >= addedAt) is flagged
 * leads.priority at discovery. Priority no longer BYPASSES the classifier — the
 * lead is graded and merely protected (skip is clamped to light, and the slop +
 * follower floors are exempted). It does still bypass the drafter quality gate.
 * Separate from getWatchlist (targeting handles/keywords, which stay filtered).
 */
export async function getWatchlistPeople(
  sql: Sql,
  instanceId: string,
): Promise<WatchlistPerson[]> {
  const rows = await sql<{ handle: string; added_at: string | Date }[]>`
    select handle, added_at
    from noelle.x_watchlist_people
    where agent_instance_id = ${instanceId}
    order by added_at asc
  `;
  return rows.map((r) => ({ handle: r.handle, addedAt: new Date(r.added_at).toISOString() }));
}

export interface WatchlistObjectiveEntry {
  kind: WatchlistObjectiveKind;
  note: string | null;
}

/**
 * Per-person objectives for the instance's watchlist, keyed by lowercased
 * handle. Only people with an objective set are included. The drafter looks a
 * lead's author up here to steer how it engages that specific person.
 */
export async function getWatchlistObjectives(
  sql: Sql,
  instanceId: string,
): Promise<Map<string, WatchlistObjectiveEntry>> {
  const rows = await sql<
    { handle: string; objective_kind: WatchlistObjectiveKind | null; objective_note: string | null }[]
  >`
    select handle, objective_kind, objective_note
    from noelle.x_watchlist_people
    where agent_instance_id = ${instanceId} and objective_kind is not null
  `;
  const map = new Map<string, WatchlistObjectiveEntry>();
  for (const r of rows) {
    if (r.objective_kind) {
      // Key by the normalized handle (matches the drafter's lookup + how
      // discovery/add normalize): lowercase, @-stripped, trimmed.
      const key = r.handle.trim().toLowerCase().replace(/^@/, "");
      map.set(key, { kind: r.objective_kind, note: r.objective_note });
    }
  }
  return map;
}
