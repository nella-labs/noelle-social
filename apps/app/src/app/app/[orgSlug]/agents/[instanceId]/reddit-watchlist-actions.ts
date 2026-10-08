"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { OrgMembershipError } from "@noelle/runtime";
import { normalizeSubreddit } from "@noelle/contracts";
import type { TransactionSql } from "postgres";
import { sql } from "@/lib/db";
import { getAgentInstance, getCurrentUser, getOrgBySlug } from "@/lib/queries";

// The agent detail + watchlist pages are reachable by BOTH the agent slug
// (/agents/orion) and the UUID; Next caches those as separate router entries.
// Revalidate the route PATTERN with type "page" so every cached variant (slug +
// UUID) refreshes after a write — see the LinkedIn watchlist-actions for the
// full rationale (the known router-cache revalidate bug).
const AGENT_PAGE_ROUTE = "/app/[orgSlug]/agents/[instanceId]";
const WATCHLIST_PAGE_ROUTE = "/app/[orgSlug]/agents/[instanceId]/watchlist";

/** Free-text per-subreddit engagement steer (the Reddit drafter reads it raw). */
const ObjectiveSchema = z.string().trim().max(240);

const AddInput = z.object({
  orgSlug: z.string().min(1),
  instanceId: z.string().uuid(),
  /** "r/SaaS", a full URL, or a bare name — normalised to the bare subreddit. */
  subreddit: z.string().min(1).max(200),
  objective: ObjectiveSchema.optional(),
  /** Optional upvote floor — threads below this are skipped. */
  minScore: z.coerce.number().int().min(0).max(1_000_000).optional(),
});

const RemoveInput = z.object({
  orgSlug: z.string().min(1),
  instanceId: z.string().uuid(),
  rowId: z.string().uuid(),
});

/**
 * Authorize a write against a specific reddit-intern instance. Verifies the
 * caller is a member of the slug's org, the target instance belongs to that org
 * (getAgentInstance runs assertOrgMember on the instance's real org_id, so a
 * caller-supplied instanceId from another org is rejected — cross-tenant IDOR),
 * AND the instance is actually a reddit_intern (this table is hers).
 */
async function authorizeRedditInstance(orgSlug: string, instanceId: string) {
  const user = await getCurrentUser();
  if (!user) return { kind: "unauthenticated" as const };
  try {
    const org = await getOrgBySlug(orgSlug);
    if (!org) return { kind: "not_found" as const };
    const instance = await getAgentInstance(instanceId);
    if (!instance || instance.org_id !== org.id) return { kind: "not_found" as const };
    if (instance.role !== "reddit_intern") return { kind: "not_found" as const };
    return { kind: "ok" as const, org };
  } catch (err) {
    if (err instanceof OrgMembershipError) return { kind: "forbidden" as const };
    throw err;
  }
}

type MutationResult = { ok: true } | { ok: false; error: "not_found" };
/** Keep parent authorization stable through both watchlist mutation paths. */
async function withLockedRedditInstance(orgId: string, instanceId: string, mutate: (tx: TransactionSql) => Promise<MutationResult>): Promise<MutationResult> {
  return sql.begin(async (tx) => {
    const [instance] = await tx<{ role: string }[]>`select role from noelle.agent_instances
      where id=${instanceId} and org_id=${orgId} for no key update`;
    if (instance?.role !== "reddit_intern") return { ok: false, error: "not_found" };
    return mutate(tx);
  });
}

/**
 * Add a subreddit to the Reddit watchlist. The operator may paste "r/SaaS", a
 * full URL, or a bare name — all collapse to the bare lowercase subreddit. Re-
 * adding an existing subreddit updates its objective + min_score.
 */
export async function addRedditWatchlistEntry(input: z.infer<typeof AddInput>) {
  const parsed = AddInput.parse(input);
  const auth = await authorizeRedditInstance(parsed.orgSlug, parsed.instanceId);
  if (auth.kind !== "ok") return { ok: false as const, error: auth.kind };

  const subreddit = normalizeSubreddit(parsed.subreddit);
  if (!subreddit) return { ok: false as const, error: "invalid" as const };

  const objective = parsed.objective?.trim() ? parsed.objective.trim() : null;
  const minScore = parsed.minScore ?? 0;

  // The native unique key makes concurrent normalized additions one row.
  // A contradictory foreign-org soft reference must not be overwritten.
  const result = await withLockedRedditInstance(auth.org.id, parsed.instanceId, async (tx) => {
    const rows = await tx<{ id: string }[]>`
    insert into noelle.reddit_watchlist
      (org_id, agent_instance_id, subreddit, objective, min_score)
    values (${auth.org.id}, ${parsed.instanceId}, ${subreddit}, ${objective}, ${minScore})
    on conflict (agent_instance_id, subreddit) do update
      set objective = excluded.objective, min_score = excluded.min_score
      where noelle.reddit_watchlist.org_id = ${auth.org.id}
    returning id
    `;
    return rows.length ? { ok: true } : { ok: false, error: "not_found" };
  });
  if (!result.ok) return result;
  revalidatePath(AGENT_PAGE_ROUTE, "page");
  revalidatePath(WATCHLIST_PAGE_ROUTE, "page");
  return result;
}

export async function removeRedditWatchlistEntry(input: z.infer<typeof RemoveInput>) {
  const parsed = RemoveInput.parse(input);
  const auth = await authorizeRedditInstance(parsed.orgSlug, parsed.instanceId);
  if (auth.kind !== "ok") return { ok: false as const, error: auth.kind };

  const result = await withLockedRedditInstance(auth.org.id, parsed.instanceId, async (tx) => {
    const rows = await tx`delete from noelle.reddit_watchlist
      where id=${parsed.rowId} and org_id=${auth.org.id} and agent_instance_id=${parsed.instanceId} returning id`;
    return rows.length ? { ok: true } : { ok: false, error: "not_found" };
  });
  if (!result.ok) return result;
  revalidatePath(AGENT_PAGE_ROUTE, "page");
  revalidatePath(WATCHLIST_PAGE_ROUTE, "page");
  return result;
}
