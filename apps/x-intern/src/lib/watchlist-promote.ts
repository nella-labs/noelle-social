import type { Sql } from "postgres";

export interface PromoteWatchlistOpts {
  /** Minimum DRAFTED leads an author needs before promotion. Default 2. */
  minDrafted?: number;
  /** Max authors promoted per run. `<= 0` disables (returns []). Default 5. */
  maxPerRun?: number;
  /**
   * How far to backdate `added_at` so the new person's recent posts seed the
   * queue immediately instead of waiting for a brand-new post (discovery skips
   * a watchlist person's pre-`added_at` posts as backfill). Default 24h.
   */
  backfillHours?: number;
}

/**
 * Self-curating watchlist. Promotes keyword-lane authors who have produced
 * `minDrafted`+ DRAFTED leads — a strong signal they are both on-ICP (their
 * posts cleared the classifier + relevance gates) AND currently live (a dead /
 * renamed handle can't produce a drafted reply) — into
 * `noelle.x_watchlist_people`, so their future posts become always-on priority
 * leads that bypass the gates.
 *
 * Idempotent: authors already on the watchlist are skipped. Safe to call every
 * tick (callers should still throttle for cost). Returns the handles promoted
 * this run (empty when nothing qualified or the feature is disabled).
 */
export async function promoteWatchlistAuthors(
  sql: Sql,
  instanceId: string,
  orgId: string,
  opts: PromoteWatchlistOpts = {},
): Promise<string[]> {
  const minDrafted = opts.minDrafted ?? 2;
  const maxPerRun = opts.maxPerRun ?? 5;
  const backfillHours = opts.backfillHours ?? 24;
  if (maxPerRun <= 0) return [];

  const rows = await sql<{ handle: string }[]>`
    insert into noelle.x_watchlist_people (org_id, agent_instance_id, handle, added_at)
    select ${orgId}, ${instanceId}, cand.author, now() - make_interval(hours => ${backfillHours})
    from (
      select lower(l.payload->>'author_handle') as author, count(*) as drafted
      from noelle.leads l
      where l.agent_instance_id = ${instanceId}
        and l.priority = false
        and l.status = 'drafted'
        and coalesce(l.payload->>'author_handle', '') <> ''
      group by 1
      having count(*) >= ${minDrafted}
    ) cand
    where not exists (
      select 1 from noelle.x_watchlist_people p
      where p.agent_instance_id = ${instanceId}
        and lower(p.handle) = cand.author
    )
    order by cand.drafted desc
    limit ${maxPerRun}
    returning handle
  `;
  return rows.map((r) => r.handle);
}
