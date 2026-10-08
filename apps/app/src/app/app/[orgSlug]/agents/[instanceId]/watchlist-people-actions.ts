"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { OrgMembershipError } from "@noelle/runtime";
import {
  WatchlistObjectiveKindSchema,
  WatchlistObjectiveNoteSchema,
} from "@noelle/contracts";
import { sql } from "@/lib/db";
import { getAgentInstance, getCurrentUser, getOrgBySlug } from "@/lib/queries";

// The agent detail + person pages are reachable by BOTH the agent slug
// (/agents/vega) and the UUID; Next caches those as separate router entries.
// Revalidating a concrete /agents/<uuid> path leaves the slug page the user is
// actually viewing stale — the write lands but the watchlist only updates on a
// hard reload. Revalidate the route PATTERN with type "page" so every cached
// variant (slug + UUID), the active page included, refreshes.
const AGENT_PAGE_ROUTE = "/app/[orgSlug]/agents/[instanceId]";

/**
 * Contacts is the single combined person surface, so every watchlist write must
 * also refresh it: the list (Watched badge/filter) and the person detail
 * ('Watched by' section). The detail is revalidated by route PATTERN so the
 * slug + UUID cache variants — and the page the operator is viewing — all
 * refresh, without threading a concrete personId through every action.
 */
function revalidateContacts(orgSlug: string) {
  revalidatePath(`/app/${orgSlug}/contacts`);
  revalidatePath("/app/[orgSlug]/contacts/[personId]", "page");
}

const AddInput = z.object({
  orgSlug: z.string().min(1),
  instanceId: z.string().uuid(),
  handle: z.string().min(1).max(80),
  objectiveKind: WatchlistObjectiveKindSchema.nullable().optional(),
  objectiveNote: WatchlistObjectiveNoteSchema.optional(),
});

const RemoveInput = z.object({
  orgSlug: z.string().min(1),
  instanceId: z.string().uuid(),
  rowId: z.string().uuid(),
});

/**
 * Authorize a write against a specific agent instance. Verifies (1) the caller
 * is a member of the slug's org AND (2) the target instance actually belongs to
 * that org — `getAgentInstance` runs `assertOrgMember` on the instance's real
 * org_id, so a caller-supplied instanceId from another org throws/forbids
 * instead of letting them write into a victim instance (cross-tenant IDOR).
 */
async function authorizeInstance(orgSlug: string, instanceId: string) {
  const user = await getCurrentUser();
  if (!user) return { kind: "unauthenticated" as const };
  try {
    const org = await getOrgBySlug(orgSlug);
    if (!org) return { kind: "not_found" as const };
    const instance = await getAgentInstance(instanceId);
    if (!instance || instance.org_id !== org.id) return { kind: "not_found" as const };
    // Role gate: x_watchlist_people is the x_intern's table. Stops a same-org
    // coordinator instance from writing Vega's watchlist via a direct action
    // call (the page notFound() only guards navigation).
    if (instance.role !== "x_intern") return { kind: "not_found" as const };
    return { kind: "ok" as const, org };
  } catch (err) {
    if (err instanceof OrgMembershipError) return { kind: "forbidden" as const };
    throw err;
  }
}

export async function addWatchlistPerson(input: z.infer<typeof AddInput>) {
  const parsed = AddInput.parse(input);
  const auth = await authorizeInstance(parsed.orgSlug, parsed.instanceId);
  if (auth.kind !== "ok") return { ok: false as const, error: auth.kind };

  const handle = parsed.handle.trim().toLowerCase().replace(/^@/, "");
  if (!handle) return { ok: false as const, error: "invalid" as const };

  const objectiveKind = parsed.objectiveKind ?? null;
  // A note without a kind is meaningless — only keep it when a kind is set.
  const objectiveNote = objectiveKind ? (parsed.objectiveNote ?? null) : null;

  // Re-adding an existing handle applies the objective the operator just
  // chose (last-write-wins on an explicit submit) rather than silently
  // no-oping and dropping their selection.
  await sql`
    insert into noelle.x_watchlist_people
      (org_id, agent_instance_id, handle, objective_kind, objective_note)
    values (${auth.org.id}, ${parsed.instanceId}, ${handle},
            ${objectiveKind}, ${objectiveNote})
    on conflict (agent_instance_id, handle) do update
      set objective_kind = excluded.objective_kind,
          objective_note = excluded.objective_note
  `;
  await ensurePersonForHandle(auth.org.id, parsed.instanceId, handle);
  revalidatePath(AGENT_PAGE_ROUTE, "page");
  revalidateContacts(parsed.orgSlug);
  return { ok: true as const };
}

/**
 * Ensure the Contacts CRM has a person + 'x' account for this handle and link
 * the watchlist row to it. Idempotent: reuses an existing 'x' account for the
 * (org, handle) when present, only creating a new person otherwise. Mirrors the
 * 0023 backfill so watchlisting someone keeps Contacts in sync in real time.
 */
async function ensurePersonForHandle(orgId: string, instanceId: string, handle: string) {
  await sql`
    with existing as (
      select person_id from noelle.person_social_accounts
      where org_id = ${orgId} and platform = 'x' and lower(handle) = ${handle}
      limit 1
    ),
    created_person as (
      insert into noelle.persons (org_id, display_name)
      select ${orgId}, ${handle}
      where not exists (select 1 from existing)
      returning id
    ),
    created_account as (
      insert into noelle.person_social_accounts (org_id, person_id, platform, handle)
      select ${orgId}, id, 'x', ${handle} from created_person
      returning person_id
    ),
    resolved as (
      select person_id from existing
      union all
      select person_id from created_account
    )
    update noelle.x_watchlist_people wp
    set person_id = (select person_id from resolved limit 1)
    where wp.agent_instance_id = ${instanceId} and wp.handle = ${handle}
  `;
}

const SetObjectiveInput = z.object({
  orgSlug: z.string().min(1),
  instanceId: z.string().uuid(),
  rowId: z.string().uuid(),
  objectiveKind: WatchlistObjectiveKindSchema.nullable(),
  objectiveNote: WatchlistObjectiveNoteSchema,
});

/**
 * Set (or clear) a watchlist person's objective. Clearing the kind also clears
 * the note (a note without a kind is meaningless). Org/instance-authorized like
 * the other watchlist writes.
 */
export async function setWatchlistPersonObjective(
  input: z.infer<typeof SetObjectiveInput>,
) {
  const parsed = SetObjectiveInput.parse(input);
  const auth = await authorizeInstance(parsed.orgSlug, parsed.instanceId);
  if (auth.kind !== "ok") return { ok: false as const, error: auth.kind };

  const objectiveNote = parsed.objectiveKind ? parsed.objectiveNote : null;

  await sql`
    update noelle.x_watchlist_people
    set objective_kind = ${parsed.objectiveKind},
        objective_note = ${objectiveNote}
    where id = ${parsed.rowId}
      and org_id = ${auth.org.id}
      and agent_instance_id = ${parsed.instanceId}
  `;
  revalidatePath(AGENT_PAGE_ROUTE, "page");
  revalidateContacts(parsed.orgSlug);
  return { ok: true as const };
}

export async function removeWatchlistPerson(input: z.infer<typeof RemoveInput>) {
  const parsed = RemoveInput.parse(input);
  const auth = await authorizeInstance(parsed.orgSlug, parsed.instanceId);
  if (auth.kind !== "ok") return { ok: false as const, error: auth.kind };

  await sql`
    delete from noelle.x_watchlist_people
    where id = ${parsed.rowId}
      and org_id = ${auth.org.id}
      and agent_instance_id = ${parsed.instanceId}
  `;
  revalidatePath(AGENT_PAGE_ROUTE, "page");
  revalidateContacts(parsed.orgSlug);
  return { ok: true as const };
}
