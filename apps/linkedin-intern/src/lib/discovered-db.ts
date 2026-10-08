import type { Sql } from "postgres";

// Persistence for people surfaced by profile-first discovery
// (noelle.linkedin_discovered_people, 0044). Every qualified candidate is
// retained so the information extracted from discovery is stored, not just used
// to mint a lead and dropped — accumulating the operator's organically-grown
// prospect list.

export interface DiscoveredPersonInput {
  orgId: string;
  agentInstanceId: string;
  /** Vanity slug (linkedin.com/in/<publicId>) — the dedup key. */
  publicId: string;
  /** urn:li:fsd_profile:<id> stripped, when known (often absent in short mode). */
  fsdProfileId: string | null;
  name: string | null;
  headline: string | null;
  /** 'profile_search' (Feeder A) | 'post_search' (keyword author gate). */
  source: "profile_search" | "post_search";
}

/**
 * Upsert a qualified discovered person. Idempotent on (agent_instance_id,
 * public_id): a re-seen person bumps seen_count + last_seen_at and refreshes
 * name/headline (and fills fsd_profile_id once it's known), so re-running
 * discovery enriches the row rather than duplicating it. Best-effort — the
 * caller swallows errors so persistence never breaks the discovery hot path.
 */
export async function upsertDiscoveredPerson(
  sql: Sql,
  p: DiscoveredPersonInput,
): Promise<void> {
  await sql`
    insert into noelle.linkedin_discovered_people
      (org_id, agent_instance_id, public_id, fsd_profile_id, name, headline, source)
    values
      (${p.orgId}, ${p.agentInstanceId}, ${p.publicId}, ${p.fsdProfileId},
       ${p.name}, ${p.headline}, ${p.source})
    on conflict (agent_instance_id, public_id) do update set
      seen_count = noelle.linkedin_discovered_people.seen_count + 1,
      last_seen_at = now(),
      name = coalesce(excluded.name, noelle.linkedin_discovered_people.name),
      headline = coalesce(excluded.headline, noelle.linkedin_discovered_people.headline),
      fsd_profile_id = coalesce(
        excluded.fsd_profile_id, noelle.linkedin_discovered_people.fsd_profile_id
      )
  `;
}
