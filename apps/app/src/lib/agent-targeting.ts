"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { OrgMembershipError } from "@noelle/runtime";
import {
  ObjectiveSchema,
  TargetingProposalSchema,
  targetingProposalMatchesRole,
  type TargetingProposal,
} from "@noelle/contracts";
import { sql } from "@/lib/db";
import type { TransactionSql } from "postgres";
import { getCurrentUser, getOrgBySlug } from "@/lib/queries";

/**
 * Server actions for an agent's objective (mission) + targeting (x_watchlist).
 *
 * Lives in lib/ rather than colocated under the agent route because three
 * unrelated surfaces call them: the Objective card on the detail page, the
 * targeting page, and the Vega chat's Apply button (a client component in
 * components/). A stable `@/lib` path keeps every caller bracket-free.
 *
 * Tenancy: each action proves org membership via getOrgBySlug (which calls
 * assertOrgMember) and scopes each mutation to that org and instance. The
 * Vega chat LLM never reaches these — it only proposes a
 * TargetingProposal; this validated, org-scoped path is the only writer.
 */

type OrgAuth =
  | { kind: "ok"; orgId: string }
  | { kind: "unauthenticated" }
  | { kind: "not_found" }
  | { kind: "forbidden" };

async function authorizeOrg(orgSlug: string): Promise<OrgAuth> {
  const user = await getCurrentUser();
  if (!user) return { kind: "unauthenticated" };
  try {
    const org = await getOrgBySlug(orgSlug);
    if (!org) return { kind: "not_found" };
    return { kind: "ok", orgId: org.id };
  } catch (err) {
    if (err instanceof OrgMembershipError) return { kind: "forbidden" };
    throw err;
  }
}

/** Revalidate every surface that renders the objective / targeting. */
function revalidateAgentSurfaces() {
  // Route PATTERNS, not concrete paths: the agent page is cached under both the
  // slug (/agents/vega) and the UUID, so revalidating a concrete /agents/<uuid>
  // path leaves the slug page the user is actually viewing stale — the write
  // lands but the UI only refreshes on a hard reload. Pattern + "page"
  // refreshes every cached variant (slug + UUID), the active page included.
  revalidatePath("/app/[orgSlug]/agents/[instanceId]", "page");
  revalidatePath("/app/[orgSlug]/agents/[instanceId]/watchlist", "page");
}

const ObjectiveInput = z.object({
  orgSlug: z.string().min(1),
  instanceId: z.string().uuid(),
  // Raw operator input. Empty / whitespace resets the objective to the manifest
  // default (stored as NULL); otherwise validated by ObjectiveSchema.
  objective: z.string().max(2_000),
});

export type UpdateObjectiveResult =
  | { ok: true; objective: string | null }
  | { ok: false; error: "unauthenticated" | "not_found" | "forbidden" | "invalid" };

/**
 * Persist the agent's mission. Empty input clears it back to the manifest
 * default (NULL). Used by the Objective card and the targeting page.
 */
export async function updateObjective(
  input: z.infer<typeof ObjectiveInput>,
): Promise<UpdateObjectiveResult> {
  const parsed = ObjectiveInput.safeParse(input);
  if (!parsed.success) return { ok: false, error: "invalid" };
  const auth = await authorizeOrg(parsed.data.orgSlug);
  if (auth.kind !== "ok") return { ok: false, error: auth.kind };
  const valid = ObjectiveSchema.nullable().safeParse(parsed.data.objective.trim() || null);
  if (!valid.success) return { ok: false, error: "invalid" };
  const [updated] = await sql<{ objective: string | null }[]>`
    update noelle.agent_instances set objective = ${valid.data}
    where id = ${parsed.data.instanceId} and org_id = ${auth.orgId}
    returning objective
  `;
  if (!updated) return { ok: false, error: "not_found" };
  revalidateAgentSurfaces();
  return { ok: true, objective: updated.objective };
}

const ApplyTargetingInput = z.object({
  orgSlug: z.string().min(1),
  instanceId: z.string().uuid(),
  // Validated by TargetingProposalSchema below.
  proposal: z.unknown(),
});

export interface ApplyTargetingResult {
  ok: boolean;
  error?: "unauthenticated" | "not_found" | "forbidden" | "invalid";
  applied?: {
    addedHandles: number; removedHandles: number;
    addedKeywords: number; removedKeywords: number;
    addedPeople: number; removedPeople: number;
    addedSubreddits: number; removedSubreddits: number;
    missionChanged: boolean;
  };
}
type AppliedSummary = NonNullable<ApplyTargetingResult["applied"]>;

/** Apply a validated diff under the scoped instance lock, reporting committed row changes. */
export async function applyTargetingChange(input: z.infer<typeof ApplyTargetingInput>): Promise<ApplyTargetingResult> {
  const parsed = ApplyTargetingInput.safeParse(input);
  if (!parsed.success) return { ok: false, error: "invalid" };
  const auth = await authorizeOrg(parsed.data.orgSlug);
  if (auth.kind !== "ok") return { ok: false, error: auth.kind };
  const validated = TargetingProposalSchema.safeParse(parsed.data.proposal);
  if (!validated.success) return { ok: false, error: "invalid" };
  const proposal = validated.data, orgId = auth.orgId, instanceId = parsed.data.instanceId;
  const result = await sql.begin(async (tx): Promise<ApplyTargetingResult> => {
    const [instance] = await tx<{ role: string }[]>`
      select role from noelle.agent_instances where id=${instanceId} and org_id=${orgId} for no key update
    `;
    if (!instance) return { ok: false, error: "not_found" };
    if (!targetingProposalMatchesRole(proposal, instance.role)) return { ok: false, error: "invalid" };
    if (await hasForeignTarget(tx, orgId, instanceId, instance.role, proposal)) return { ok: false, error: "not_found" };
    const applied: AppliedSummary = { addedHandles: 0, removedHandles: 0, addedKeywords: 0, removedKeywords: 0, addedPeople: 0, removedPeople: 0, addedSubreddits: 0, removedSubreddits: 0, missionChanged: false };
    if (instance.role === "x_intern") await applyXChange(tx, orgId, instanceId, proposal, applied);
    else if (instance.role === "linkedin_intern") await applyLinkedInChange(tx, orgId, instanceId, proposal, applied);
    else if (instance.role === "reddit_intern") await applyRedditChange(tx, orgId, instanceId, proposal, applied);
    else return { ok: false, error: "invalid" };
    if (proposal.mission !== undefined) {
      const rows = await tx`update noelle.agent_instances set objective=${proposal.mission}
        where id=${instanceId} and org_id=${orgId} and objective is distinct from ${proposal.mission} returning id`;
      applied.missionChanged = rows.length > 0;
    }
    return { ok: true, applied };
  });
  if (result.ok) revalidateAgentSurfaces();
  return result;
}

/** Refuse a matching target whose soft instance reference contradicts its tenant. */
async function hasForeignTarget(tx: TransactionSql, orgId: string, instanceId: string, role: string, proposal: TargetingProposal): Promise<boolean> {
  if (role === "x_intern") return (await tx`select id from noelle.x_watchlist where agent_instance_id=${instanceId} and org_id<>${orgId}
    and ((kind='handle' and value=any(${[...proposal.addHandles, ...proposal.removeHandles]}))
      or (kind='keyword' and value=any(${[...proposal.addKeywords, ...proposal.removeKeywords]}))) limit 1`).length > 0;
  if (role === "linkedin_intern") {
    const people = [...proposal.addPeople, ...proposal.removePeople];
    return (await tx`select id from noelle.linkedin_watchlist_people where agent_instance_id=${instanceId} and org_id<>${orgId}
      and (lower(public_id)=any(${people}) or fsd_profile_id=any(${people})) limit 1`).length > 0;
  }
  if (role === "reddit_intern") return (await tx`select id from noelle.reddit_watchlist where agent_instance_id=${instanceId} and org_id<>${orgId}
    and subreddit=any(${[...proposal.addSubreddits, ...proposal.removeSubreddits]}) limit 1`).length > 0;
  return false;
}

async function applyXChange(tx: TransactionSql, orgId: string, instanceId: string, proposal: TargetingProposal, applied: AppliedSummary) {
  const inserts = [
    ...proposal.addHandles.map((value) => ({ org_id: orgId, agent_instance_id: instanceId, kind: "handle", value })),
    ...proposal.addKeywords.map((value) => ({ org_id: orgId, agent_instance_id: instanceId, kind: "keyword", value })),
  ];
  if (inserts.length) {
    const rows = await tx<{ kind: string }[]>`insert into noelle.x_watchlist ${tx(inserts, "org_id", "agent_instance_id", "kind", "value")}
      on conflict (agent_instance_id,kind,value) do nothing returning kind`;
    applied.addedHandles = rows.filter((row) => row.kind === "handle").length;
    applied.addedKeywords = rows.filter((row) => row.kind === "keyword").length;
  }
  if (proposal.removeHandles.length) applied.removedHandles = (await tx`delete from noelle.x_watchlist
    where org_id=${orgId} and agent_instance_id=${instanceId} and kind='handle' and value=any(${proposal.removeHandles}) returning id`).length;
  if (proposal.removeKeywords.length) applied.removedKeywords = (await tx`delete from noelle.x_watchlist
    where org_id=${orgId} and agent_instance_id=${instanceId} and kind='keyword' and value=any(${proposal.removeKeywords}) returning id`).length;
}

async function applyLinkedInChange(tx: TransactionSql, orgId: string, instanceId: string, proposal: TargetingProposal, applied: AppliedSummary) {
  if (proposal.addPeople.length) {
    // Resolved profiles can have a stable ID different from their public slug.
    const rows = await tx`insert into noelle.linkedin_watchlist_people(org_id,agent_instance_id,fsd_profile_id,public_id)
      select ${orgId}::uuid,${instanceId}::uuid,public_id,public_id from unnest(${proposal.addPeople}::text[]) as candidates(public_id)
      where not exists (select 1 from noelle.linkedin_watchlist_people current
        where current.org_id=${orgId} and current.agent_instance_id=${instanceId} and lower(current.public_id)=candidates.public_id)
      on conflict (agent_instance_id,fsd_profile_id) do nothing returning id`;
    applied.addedPeople = rows.length;
  }
  if (proposal.removePeople.length) applied.removedPeople = (await tx`delete from noelle.linkedin_watchlist_people
    where org_id=${orgId} and agent_instance_id=${instanceId} and lower(public_id)=any(${proposal.removePeople}) returning id`).length;
}

async function applyRedditChange(tx: TransactionSql, orgId: string, instanceId: string, proposal: TargetingProposal, applied: AppliedSummary) {
  if (proposal.addSubreddits.length) {
    // Adding a watched community preserves its per-community objective and score floor.
    const rows = await tx`insert into noelle.reddit_watchlist(org_id,agent_instance_id,subreddit)
      select ${orgId}::uuid,${instanceId}::uuid,subreddit from unnest(${proposal.addSubreddits}::text[]) as candidates(subreddit)
      on conflict (agent_instance_id,subreddit) do nothing returning id`;
    applied.addedSubreddits = rows.length;
  }
