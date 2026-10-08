"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { OrgMembershipError } from "@noelle/runtime";
import { AccountFeederSourceSchema } from "@noelle/contracts";
import { sql } from "@/lib/db";
import { getAgentInstance, getCurrentUser, getOrgBySlug } from "@/lib/queries";

// Server actions for the Account Feeder "style sources" surface. Each one:
//   - validates its input (the source shape via AccountFeederSourceSchema, which
//     trims + lowercases the handle so the (instance, platform, handle) unique
//     key stays stable),
//   - authorizes against a LinkedIn-intern instance the caller belongs to (the
//     feeder is Lyra's; authorizeLinkedInInstance asserts membership + role +
//     the org_id match, the cross-tenant IDOR guard), and
//   - revalidates the route PATTERN (not a concrete /agents/<uuid>) so every
//     cached variant (slug + UUID) of both the agent page and the feeder subpage
//     refreshes — see actions.ts:25 for the full rationale.

const AGENT_PAGE_ROUTE = "/app/[orgSlug]/agents/[instanceId]";
const FEEDER_PAGE_ROUTE = "/app/[orgSlug]/agents/[instanceId]/feeder";

/**
 * Authorize a write against a specific LinkedIn-intern instance. Same shape as
 * the LinkedIn watchlist actions: caller must be a member of the slug's org, the
 * target instance must belong to that org (getAgentInstance runs assertOrgMember
 * on the row's real org_id — a caller-supplied instanceId from another org is
 * rejected), AND the instance must be a linkedin_intern (the feeder is hers).
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

function revalidateFeeder() {
  revalidatePath(AGENT_PAGE_ROUTE, "page");
  revalidatePath(FEEDER_PAGE_ROUTE, "page");
}

const AddInput = z.object({
  orgSlug: z.string().min(1),
  instanceId: z.string().uuid(),
  /** Raw handle/URL/slug — normalised by AccountFeederSourceSchema below. */
  handle: z.string().min(1).max(200),
  displayName: z.string().trim().max(200).optional(),
  note: z.string().trim().max(500).optional(),
});

const RemoveInput = z.object({
  orgSlug: z.string().min(1),
  instanceId: z.string().uuid(),
  rowId: z.string().uuid(),
});

const ToggleInput = z.object({
  orgSlug: z.string().min(1),
  instanceId: z.string().uuid(),
  rowId: z.string().uuid(),
  enabled: z.boolean(),
});

const SetNoteInput = z.object({
  orgSlug: z.string().min(1),
  instanceId: z.string().uuid(),
  rowId: z.string().uuid(),
  note: z.string().trim().max(500),
});

const RunInput = z.object({
  orgSlug: z.string().min(1),
  instanceId: z.string().uuid(),
});

/**
 * Strip a pasted LinkedIn profile URL down to its vanity slug before the
 * contract normalises (trim/lowercase) it. The operator may paste a full
 * `https://www.linkedin.com/in/<slug>/` URL, an `/in/<slug>` path, or a bare
 * handle; all collapse to the slug the feeder queries Apify by. A non-LinkedIn
 * (e.g. X) handle without a path is returned as-is.
 */
function extractHandle(raw: string): string {
  const trimmed = raw.trim();
  const m = trimmed.match(/linkedin\.com\/in\/([^/?#]+)/i) ?? trimmed.match(/^\/?in\/([^/?#]+)/i);
  return (m ? m[1] : trimmed).replace(/^@/, "");
}

/**
 * Add (or re-enable / re-label) a curated source account. Bootstraps an enabled
 * row; re-adding the same handle updates the note/display_name and re-enables it
 * (the unique (instance, platform, handle) constraint dedupes). The next feeder
 * run pulls every enabled source.
 */
export async function addFeederSource(input: z.infer<typeof AddInput>) {
  const parsed = AddInput.parse(input);
  const auth = await authorizeLinkedInInstance(parsed.orgSlug, parsed.instanceId);
  if (auth.kind !== "ok") return { ok: false as const, error: auth.kind };

  // Normalise via the contract (trims + lowercases handle; defaults platform to
  // linkedin). extractHandle first so a pasted profile URL becomes a bare slug.
  const source = AccountFeederSourceSchema.safeParse({
    handle: extractHandle(parsed.handle),
    displayName: parsed.displayName,
    note: parsed.note,
  });
  if (!source.success) return { ok: false as const, error: "invalid" as const };
  const { handle, platform, displayName, note } = source.data;
  if (!handle) return { ok: false as const, error: "invalid" as const };

  await sql`
    insert into noelle.account_feeder_sources
      (org_id, agent_instance_id, platform, handle, display_name, note, enabled)
    values (
      ${auth.org.id}, ${parsed.instanceId}, ${platform}, ${handle},
      ${displayName ?? null}, ${note ?? null}, true
    )
    on conflict (agent_instance_id, platform, handle) do update
      set display_name = excluded.display_name,
          note         = excluded.note,
          enabled      = true
  `;
  revalidateFeeder();
  return { ok: true as const };
}

/** Remove a source account from the curated list. */
export async function removeFeederSource(input: z.infer<typeof RemoveInput>) {
  const parsed = RemoveInput.parse(input);
  const auth = await authorizeLinkedInInstance(parsed.orgSlug, parsed.instanceId);
  if (auth.kind !== "ok") return { ok: false as const, error: auth.kind };

  await sql`
    delete from noelle.account_feeder_sources
    where id = ${parsed.rowId}
      and org_id = ${auth.org.id}
      and agent_instance_id = ${parsed.instanceId}
  `;
  revalidateFeeder();
  return { ok: true as const };
}

/**
 * Enable / disable a source without removing it. A disabled source is skipped on
 * the next run but keeps its (now stale) corpus + ultra profile.
 */
export async function toggleFeederSource(input: z.infer<typeof ToggleInput>) {
  const parsed = ToggleInput.parse(input);
  const auth = await authorizeLinkedInInstance(parsed.orgSlug, parsed.instanceId);
  if (auth.kind !== "ok") return { ok: false as const, error: auth.kind };

  await sql`
    update noelle.account_feeder_sources
    set enabled = ${parsed.enabled}
    where id = ${parsed.rowId}
      and org_id = ${auth.org.id}
      and agent_instance_id = ${parsed.instanceId}
  `;
  revalidateFeeder();
  return { ok: true as const };
}

/** Set (or clear) a source's operator note ("why we admire this account"). */
export async function setFeederSourceNote(input: z.infer<typeof SetNoteInput>) {
  const parsed = SetNoteInput.parse(input);
  const auth = await authorizeLinkedInInstance(parsed.orgSlug, parsed.instanceId);
  if (auth.kind !== "ok") return { ok: false as const, error: auth.kind };

  const note = parsed.note.trim() ? parsed.note.trim() : null;
  await sql`
    update noelle.account_feeder_sources
    set note = ${note}
    where id = ${parsed.rowId}
      and org_id = ${auth.org.id}
      and agent_instance_id = ${parsed.instanceId}
  `;
  revalidateFeeder();
  return { ok: true as const };
}

/**
 * Request a feeder pull: stamp account_feeder_run_requested_at = now() on the
 * instance. This is a DB-flag flip the F5 worker polls (the §2.3 manual-run
 * pattern, mirroring startAll's pipeline_started_at) — it does NOT pull
 * synchronously and costs nothing here; the worker picks it up next tick, runs
 * the (paid) Apify + Gemini pull, then clears the flag + stamps
 * account_feeder_last_run_at. Re-requesting while a request is already pending is
 * a harmless no-op (the timestamp just moves forward); the UI disables the button
 * in that window anyway.
 */
