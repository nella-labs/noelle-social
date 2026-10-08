"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { OrgMembershipError } from "@noelle/runtime";
import { sql } from "@/lib/db";
import { getAgentInstance, getCurrentUser, getOrgBySlug } from "@/lib/queries";

// Route PATTERN, not a concrete path: the watchlist subpage is cached under
// both the agent slug (/agents/vega/watchlist) and the UUID. Revalidating the
// concrete /agents/<uuid>/watchlist path leaves the slug page the user is
// viewing stale (edit lands, list doesn't update until a hard reload).
const WATCHLIST_PAGE_ROUTE = "/app/[orgSlug]/agents/[instanceId]/watchlist";

const AddInput = z.object({
  orgSlug: z.string().min(1),
  instanceId: z.string().uuid(),
  kind: z.enum(["handle", "keyword"]),
  value: z.string().min(1).max(200),
});

const RemoveInput = z.object({
  orgSlug: z.string().min(1),
  instanceId: z.string().uuid(),
  rowId: z.string().uuid(),
});

/**
 * Authorize a write against a specific agent instance: caller must be a member
 * of the slug's org, the target instance must belong to that org, AND it must be
 * an x_intern (x_watchlist is its table). getAgentInstance runs assertOrgMember
 * on the instance's real org_id, closing the cross-tenant IDOR where a member of
 * org A passes org B's instanceId; the role gate stops a same-org coordinator
 * instance from writing into an intern's targeting via a direct action call (the
 * page notFound() only guards navigation).
 */
async function authorizeInstance(
  orgSlug: string,
  instanceId: string,
  role: "x_intern" | "linkedin_intern" = "x_intern",
) {
  const user = await getCurrentUser();
  if (!user) return { kind: "unauthenticated" as const };
  try {
    const org = await getOrgBySlug(orgSlug);
    if (!org) return { kind: "not_found" as const };
    const instance = await getAgentInstance(instanceId);
    if (!instance || instance.org_id !== org.id) return { kind: "not_found" as const };
    if (instance.role !== role) return { kind: "not_found" as const };
    return { kind: "ok" as const, org };
  } catch (err) {
    if (err instanceof OrgMembershipError) return { kind: "forbidden" as const };
    throw err;
  }
}

export async function addWatchlistEntry(input: z.infer<typeof AddInput>) {
  const parsed = AddInput.parse(input);
  const auth = await authorizeInstance(parsed.orgSlug, parsed.instanceId);
  if (auth.kind !== "ok") return { ok: false as const, error: auth.kind };

  const value =
    parsed.kind === "handle"
      ? parsed.value.trim().toLowerCase().replace(/^@/, "")
      : parsed.value.trim();

  await sql`
    insert into noelle.x_watchlist (org_id, agent_instance_id, kind, value)
    values (${auth.org.id}, ${parsed.instanceId}, ${parsed.kind}, ${value})
    on conflict (agent_instance_id, kind, value) do nothing
  `;
  revalidatePath(WATCHLIST_PAGE_ROUTE, "page");
  return { ok: true as const };
}

export async function removeWatchlistEntry(input: z.infer<typeof RemoveInput>) {
  const parsed = RemoveInput.parse(input);
  const auth = await authorizeInstance(parsed.orgSlug, parsed.instanceId);
  if (auth.kind !== "ok") return { ok: false as const, error: auth.kind };
  await sql`
    delete from noelle.x_watchlist
    where id = ${parsed.rowId}
      and org_id = ${auth.org.id}
      and agent_instance_id = ${parsed.instanceId}
  `;
  revalidatePath(WATCHLIST_PAGE_ROUTE, "page");
  return { ok: true as const };
}

// ── LinkedIn keyword (SEARCH lane) targeting — noelle.linkedin_watchlist ──────
// Lyra's parallel to Vega's x_watchlist keywords: free-text topics the discovery
// worker searches LinkedIn-wide for high-engagement posts from OUTSIDE the
// network. Gated to role='linkedin_intern' (its table) — same IDOR/role guards.

const AddKeywordInput = z.object({
  orgSlug: z.string().min(1),
  instanceId: z.string().uuid(),
  value: z.string().min(1).max(200),
});

export async function addLinkedinKeyword(input: z.infer<typeof AddKeywordInput>) {
  const parsed = AddKeywordInput.parse(input);
  const auth = await authorizeInstance(parsed.orgSlug, parsed.instanceId, "linkedin_intern");
  if (auth.kind !== "ok") return { ok: false as const, error: auth.kind };
  const value = parsed.value.trim();
  if (!value) return { ok: false as const, error: "empty" as const };
  await sql`
    insert into noelle.linkedin_watchlist (org_id, agent_instance_id, kind, value)
    values (${auth.org.id}, ${parsed.instanceId}, 'keyword', ${value})
    on conflict (agent_instance_id, kind, value) do nothing
  `;
  revalidatePath(WATCHLIST_PAGE_ROUTE, "page");
  return { ok: true as const };
}

export async function removeLinkedinKeyword(input: z.infer<typeof RemoveInput>) {
  const parsed = RemoveInput.parse(input);
  const auth = await authorizeInstance(parsed.orgSlug, parsed.instanceId, "linkedin_intern");
  if (auth.kind !== "ok") return { ok: false as const, error: auth.kind };
  await sql`
    delete from noelle.linkedin_watchlist
    where id = ${parsed.rowId}
      and org_id = ${auth.org.id}
      and agent_instance_id = ${parsed.instanceId}
  `;
  revalidatePath(WATCHLIST_PAGE_ROUTE, "page");
  return { ok: true as const };
}
