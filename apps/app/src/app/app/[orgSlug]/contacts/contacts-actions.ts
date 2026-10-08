"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { OrgMembershipError } from "@noelle/runtime";
import { sql } from "@/lib/db";
import { getOrgBySlug, getPersonForOrg } from "@/lib/queries";

const UpdateProfileInput = z.object({
  orgSlug: z.string().min(1),
  personId: z.string().uuid(),
  displayName: z.string().max(120).optional(),
  notes: z.string().max(4000).optional(),
});

const RefreshProfileInput = z.object({
  orgSlug: z.string().min(1),
  personId: z.string().uuid(),
});

const RequestDmInput = z.object({
  orgSlug: z.string().min(1),
  personId: z.string().uuid(),
});

export type ContactActionResult =
  | { ok: true }
  | { ok: false; error: "unauthenticated" | "forbidden" | "not_found" | "invalid" };

export type RequestDmResult =
  | { ok: true }
  | { ok: false; error: "unauthenticated" | "forbidden" | "not_found" | "no_post" };

/**
 * Authorize against a contact: verify (1) the slug resolves to an org, (2) the
 * caller is a member of it, and (3) the person belongs to that org. We reuse
 * getPersonForOrg, which runs assertOrgMember and id+org scopes the row — so a
 * caller-supplied personId from another org throws/forbids instead of leaking.
 */
async function authorizeContact(orgSlug: string, personId: string) {
  const org = await getOrgBySlug(orgSlug);
  if (!org) return { kind: "not_found" as const };
  try {
    const person = await getPersonForOrg(org.id, personId);
    if (!person) return { kind: "not_found" as const };
    return { kind: "ok" as const, orgId: org.id, person };
  } catch (err) {
    if (err instanceof OrgMembershipError) return { kind: "forbidden" as const };
    throw err;
  }
}

/** Edit a contact's display name + CRM notes ("more info"). */
export async function updatePersonProfile(
  input: z.infer<typeof UpdateProfileInput>,
): Promise<ContactActionResult> {
  const parsed = UpdateProfileInput.parse(input);
  const auth = await authorizeContact(parsed.orgSlug, parsed.personId);
  if (auth.kind !== "ok") return { ok: false, error: auth.kind };

  const displayName = parsed.displayName?.trim() || null;
  const notes = parsed.notes?.trim() || null;
  await sql`
    update noelle.persons
    set display_name = ${displayName}, notes = ${notes}, updated_at = now()
    where id = ${parsed.personId} and org_id = ${auth.orgId}
  `;
  revalidatePath(`/app/${parsed.orgSlug}/contacts/${parsed.personId}`);
  revalidatePath(`/app/${parsed.orgSlug}/contacts`);
  return { ok: true };
}

/**
 * Force a re-profile of a contact: null out refreshed_at on every profile row
 * for this contact's handle across the org's agent instances, so the profiler
 * regenerates the summary on its next tick. Covers BOTH the X (Vega) and
 * LinkedIn (Lyra) profile tables, keyed by the contact's X handle / LinkedIn
 * public_id respectively. Org-scoped (not instance-scoped) because Contacts
 * shows the freshest profile across agents — a single Refresh should cover them
 * all. No-op for a platform the contact isn't on, or with no profile row yet.
 */
export async function requestContactProfileRefresh(
  input: z.infer<typeof RefreshProfileInput>,
): Promise<ContactActionResult> {
  const parsed = RefreshProfileInput.parse(input);
  const auth = await authorizeContact(parsed.orgSlug, parsed.personId);
  if (auth.kind !== "ok") return { ok: false, error: auth.kind };

  const xHandle = auth.person.xHandle;
  if (xHandle) {
    await sql`
      update noelle.x_watchlist_profiles
      set refreshed_at = null, updated_at = now()
      where org_id = ${auth.orgId} and lower(handle) = ${xHandle.toLowerCase()}
    `;
  }
  const linkedinHandle = auth.person.linkedinHandle;
  if (linkedinHandle) {
    await sql`
      update noelle.linkedin_watchlist_profiles
      set refreshed_at = null, updated_at = now()
      where org_id = ${auth.orgId} and lower(public_id) = ${linkedinHandle.toLowerCase()}
    `;
  }
  revalidatePath(`/app/${parsed.orgSlug}/contacts/${parsed.personId}`);
  return { ok: true };
}

/**
 * On-demand DM: flag the contact's most recent lead-with-a-post for a one-off
 * DM (payload.dm_requested). The owning agent's drafter (Vega or Lyra) picks it
 * up on its next tick, generates a single DM from the operator's voice, and
 * queues it for approval — auto-DM stays off. Keyed by the contact's X handle /
 * LinkedIn public_id, so it targets whichever platform the person is on. Returns
 * 'no_post' when there's no lead with post text to base a DM on yet.
 */
export async function requestDmForPerson(
  input: z.infer<typeof RequestDmInput>,
): Promise<RequestDmResult> {
  const parsed = RequestDmInput.parse(input);
  const auth = await authorizeContact(parsed.orgSlug, parsed.personId);
  if (auth.kind !== "ok") return { ok: false, error: auth.kind };

  const handles = [auth.person.xHandle, auth.person.linkedinHandle]
    .filter((h): h is string => !!h)
    .map((h) => h.toLowerCase());
  if (handles.length === 0) return { ok: false, error: "no_post" };

  // Flag the person's most recent lead that carries post text. The drafter's
  // claimDmRequestLeads picks it up regardless of the lead's status (the reply
  // was already handled) and generates only the DM.
  const rows = await sql<{ id: string }[]>`
    update noelle.leads
    set payload = payload || '{"dm_requested": true}'::jsonb, updated_at = now()
    where id = (
      select l.id
      from noelle.leads l
      where l.org_id = ${auth.orgId}
        and lower(l.author_handle) = any(${handles})
        and coalesce(l.payload->>'text', '') <> ''
      order by l.created_at desc
      limit 1
    )
    returning id
  `;
  if (rows.length === 0) return { ok: false, error: "no_post" };

  revalidatePath(`/app/${parsed.orgSlug}/contacts/${parsed.personId}`);
  return { ok: true };
}
