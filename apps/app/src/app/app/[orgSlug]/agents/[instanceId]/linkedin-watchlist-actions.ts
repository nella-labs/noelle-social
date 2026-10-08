"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { OrgMembershipError } from "@noelle/runtime";
import { linkedinPublicId } from "@noelle/contracts";
import { sql } from "@/lib/db";
import { getAgentInstance, getCurrentUser, getOrgBySlug } from "@/lib/queries";

// The agent detail page is reachable by BOTH the agent slug (/agents/lyra) and
// the UUID; Next caches those as separate router entries. Revalidate the route
// PATTERN with type "page" so every cached variant (slug + UUID) refreshes after
// a write — see the X watchlist-people-actions for the full rationale.
const AGENT_PAGE_ROUTE = "/app/[orgSlug]/agents/[instanceId]";
const WATCHLIST_PAGE_ROUTE = "/app/[orgSlug]/agents/[instanceId]/watchlist";

/**
 * Contacts is the single combined person surface, so every LinkedIn watchlist
 * write refreshes it too: the list (Watched badge/filter) and the person detail
 * ('Watched by'). Revalidate the detail by route PATTERN so the slug + UUID
 * cache variants both refresh. Mirrors the X watchlist-people-actions helper.
 */
function revalidateContacts(orgSlug: string) {
  revalidatePath(`/app/${orgSlug}/contacts`);
  revalidatePath("/app/[orgSlug]/contacts/[personId]", "page");
}

/**
 * Ensure the Contacts CRM has a person + 'linkedin' account for this public_id.
 * Idempotent: reuses an existing 'linkedin' account for the (org, public_id),
 * only minting a new person otherwise. The LinkedIn counterpart to the X
 * ensurePersonForHandle — watchlisting someone on LinkedIn keeps Contacts in
 * sync in real time, instead of waiting for the next contacts-load reconcile.
 */
async function ensurePersonForLinkedIn(orgId: string, publicId: string) {
  const url = `https://www.linkedin.com/in/${publicId}`;
  await sql`
    with existing as (
      select 1 from noelle.person_social_accounts
      where org_id = ${orgId} and platform = 'linkedin' and lower(handle) = ${publicId}
      limit 1
    ),
    created_person as (
      insert into noelle.persons (org_id, display_name)
      select ${orgId}, ${publicId}
      where not exists (select 1 from existing)
      returning id
    )
    insert into noelle.person_social_accounts (org_id, person_id, platform, handle, url)
    select ${orgId}, id, 'linkedin', ${publicId}, ${url} from created_person
  `;
}

/** Free-text per-person engagement steer (the LinkedIn drafter reads it raw). */
const ObjectiveSchema = z.string().trim().max(240);

const AddInput = z.object({
  orgSlug: z.string().min(1),
  instanceId: z.string().uuid(),
  /** Full URL, /in/<slug>, or a bare slug — normalised to public_id below. */
  publicId: z.string().min(1).max(200),
  objective: ObjectiveSchema.optional(),
});

const RemoveInput = z.object({
  orgSlug: z.string().min(1),
  instanceId: z.string().uuid(),
  rowId: z.string().uuid(),
});

const SetObjectiveInput = z.object({
  orgSlug: z.string().min(1),
  instanceId: z.string().uuid(),
  rowId: z.string().uuid(),
  objective: ObjectiveSchema,
});

/**
 * Authorize a write against a specific LinkedIn-intern instance. Verifies the
 * caller is a member of the slug's org, the target instance belongs to that org
 * (getAgentInstance runs assertOrgMember on the instance's real org_id, so a
 * caller-supplied instanceId from another org is rejected — cross-tenant IDOR),
 * AND the instance is actually a linkedin_intern (these tables are hers).
 */
async function authorizeLinkedInInstance(orgSlug: string, instanceId: string) {
  const user = await getCurrentUser();
  if (!user) return { kind: "unauthenticated" as const };
  try {
    const org = await getOrgBySlug(orgSlug);
    if (!org) return { kind: "not_found" as const };
    const instance = await getAgentInstance(instanceId);
    if (!instance || instance.org_id !== org.id) return { kind: "not_found" as const };
    if (instance.role !== "linkedin_intern") return { kind: "not_found" as const };
    return { kind: "ok" as const, org };
  } catch (err) {
    if (err instanceof OrgMembershipError) return { kind: "forbidden" as const };
    throw err;
  }
}

/**
 * Add a person to the LinkedIn watchlist by profile reference. The operator may
 * paste a full profile URL, a /in/<slug> path, or a bare slug — all collapse to
 * the public_id. We bootstrap fsd_profile_id = public_id (the worker doesn't know
 * the stable urn at add time; the unique (instance, fsd_profile_id) constraint
 * dedupes on the slug and discovery queries Apify by public_id immediately). The
 * profiler later fills name/headline. Re-adding applies the just-typed objective.
 */
export async function addLinkedInWatchlistPerson(input: z.infer<typeof AddInput>) {
  const parsed = AddInput.parse(input);
  const auth = await authorizeLinkedInInstance(parsed.orgSlug, parsed.instanceId);
  if (auth.kind !== "ok") return { ok: false as const, error: auth.kind };

  const publicId = linkedinPublicId(parsed.publicId);
  if (!publicId) return { ok: false as const, error: "invalid" as const };

  const objective = parsed.objective?.trim() ? parsed.objective.trim() : null;

  await sql`
    insert into noelle.linkedin_watchlist_people
      (org_id, agent_instance_id, fsd_profile_id, public_id, objective)
    values (${auth.org.id}, ${parsed.instanceId}, ${publicId}, ${publicId}, ${objective})
    on conflict (agent_instance_id, fsd_profile_id) do update
      set objective = excluded.objective
  `;
  await ensurePersonForLinkedIn(auth.org.id, publicId);
  revalidatePath(AGENT_PAGE_ROUTE, "page");
  revalidatePath(WATCHLIST_PAGE_ROUTE, "page");
  revalidateContacts(parsed.orgSlug);
  return { ok: true as const };
}

/** Set (or clear) a watchlist person's free-text objective. */
export async function setLinkedInWatchlistPersonObjective(
  input: z.infer<typeof SetObjectiveInput>,
) {
  const parsed = SetObjectiveInput.parse(input);
  const auth = await authorizeLinkedInInstance(parsed.orgSlug, parsed.instanceId);
  if (auth.kind !== "ok") return { ok: false as const, error: auth.kind };

  const objective = parsed.objective.trim() ? parsed.objective.trim() : null;

  await sql`
    update noelle.linkedin_watchlist_people
    set objective = ${objective}
    where id = ${parsed.rowId}
      and org_id = ${auth.org.id}
      and agent_instance_id = ${parsed.instanceId}
  `;
  revalidatePath(AGENT_PAGE_ROUTE, "page");
  revalidatePath(WATCHLIST_PAGE_ROUTE, "page");
  revalidateContacts(parsed.orgSlug);
  return { ok: true as const };
}

export async function removeLinkedInWatchlistPerson(input: z.infer<typeof RemoveInput>) {
  const parsed = RemoveInput.parse(input);
  const auth = await authorizeLinkedInInstance(parsed.orgSlug, parsed.instanceId);
  if (auth.kind !== "ok") return { ok: false as const, error: auth.kind };

  await sql`
    delete from noelle.linkedin_watchlist_people
    where id = ${parsed.rowId}
      and org_id = ${auth.org.id}
      and agent_instance_id = ${parsed.instanceId}
  `;
  revalidatePath(AGENT_PAGE_ROUTE, "page");
  revalidatePath(WATCHLIST_PAGE_ROUTE, "page");
  revalidateContacts(parsed.orgSlug);
  return { ok: true as const };
}
