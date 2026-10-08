import type { Sql } from "postgres";

// Persistence for people surfaced by person-first discovery
// (noelle.x_discovered_people, 0090). Vega's lead model was entirely POST-first:
// the keyword lane found tweets, minted leads from the good ones, and threw the
// author away — so a person who clearly matches the ICP but whose current tweet
// was not reply-worthy left no trace and had to be re-discovered from scratch
// every time. Retaining them accumulates the operator's organically-grown
// prospect list, which is what Lyra has had since #185.
//
// Deliberately NOT the same thing as the watchlist. The watchlist is
// always-reply and hand-curated (or auto-promoted after N drafted replies);
// this is a candidate pool, gated on WHO someone is, whose posts are polled as
// ordinary non-priority leads.

/** @-stripped, lowercased — matches how every other X table stores a handle. */
export function normalizeHandle(handle: string): string {
  return handle.trim().toLowerCase().replace(/^@/, "");
}

export interface DiscoveredPersonInput {
  orgId: string;
  agentInstanceId: string;
  /** Raw or @-prefixed; normalised here so callers cannot drift. */
  handle: string;
  /** Numeric X user id when known — stable across a handle rename. */
  authorId: string | null;
  displayName: string | null;
  /** The bio the ICP gate qualified on, kept so the decision is auditable. */
  bio: string | null;
  /**
   * Which lane surfaced this person:
   *   'keyword_author'  — an author seen in the keyword lane's search results.
   *   'follower_scrape' — harvested from a seed account's audience (the feeder).
   *   'profile_search'  — reserved for a future keyword→user search actor, if
   *                       one ever becomes trustworthy on a free Apify plan.
   */
  source: "keyword_author" | "follower_scrape" | "profile_search";
}

/**
 * Upsert a qualified discovered person. Idempotent on (agent_instance_id,
 * handle): a re-seen person bumps seen_count + last_seen_at and enriches
 * name/bio/author_id rather than duplicating. Best-effort — callers swallow
 * errors so retention never breaks the discovery hot path.
 */
export async function upsertDiscoveredPerson(
  sql: Sql,
  p: DiscoveredPersonInput,
): Promise<void> {
  const handle = normalizeHandle(p.handle);
  if (!handle) return;
  await sql`
    insert into noelle.x_discovered_people
      (org_id, agent_instance_id, handle, author_id, display_name, bio, source)
    values
      (${p.orgId}, ${p.agentInstanceId}, ${handle}, ${p.authorId},
       ${p.displayName}, ${p.bio}, ${p.source})
    on conflict (agent_instance_id, handle) do update set
      seen_count = noelle.x_discovered_people.seen_count + 1,
      last_seen_at = now(),
      display_name = coalesce(excluded.display_name, noelle.x_discovered_people.display_name),
      bio = coalesce(excluded.bio, noelle.x_discovered_people.bio),
      author_id = coalesce(excluded.author_id, noelle.x_discovered_people.author_id)
  `;
}

export interface PersonToPoll {
  handle: string;
  authorId: string | null;
}

/**
 * The next people whose timelines are worth polling: least-recently-polled
 * first, never-polled first of all, tie-broken by how often discovery has
 * re-surfaced them (a popularity proxy).
 *
 * `cooldownHours` skips anyone polled inside the window, so one person cannot be
 * re-fetched every tick while the rest of the list starves — the same starvation
 * the source-ring rotation fixed for the keyword lane (#496). Returns [] on any
 * error: this lane is additive, and a DB blip must not break discovery.
 */
export async function listPeopleToPoll(
  sql: Sql,
  args: { agentInstanceId: string; limit: number; cooldownHours: number },
): Promise<PersonToPoll[]> {
  if (args.limit <= 0) return [];
  try {
    const rows = await sql<Array<{ handle: string; author_id: string | null }>>`
      select handle, author_id
      from noelle.x_discovered_people
      where agent_instance_id = ${args.agentInstanceId}
        and (
          last_polled_at is null
          or last_polled_at < now() - make_interval(hours => ${args.cooldownHours})
        )
      order by last_polled_at asc nulls first, seen_count desc
      limit ${args.limit}
    `;
    return rows.map((r) => ({ handle: r.handle, authorId: r.author_id }));
  } catch {
    return [];
  }
}

/**
 * Stamp a person as polled. Called even when the fetch FAILED, so a person whose
 * timeline errors cools down like everyone else instead of being retried every
 * tick at the front of the queue.
 */
export async function markPersonPolled(
  sql: Sql,
  args: { agentInstanceId: string; handle: string },
): Promise<void> {
  try {
    await sql`
      update noelle.x_discovered_people
      set last_polled_at = now()
      where agent_instance_id = ${args.agentInstanceId}
        and handle = ${normalizeHandle(args.handle)}
    `;
  } catch {
    /* best-effort */
  }
}
