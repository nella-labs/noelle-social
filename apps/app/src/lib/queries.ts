import { cache } from "react";
import { readApifySpendData } from "./apify-spend-db";
import { apifyTokenSpend, summarizeApifyProviderSpend, type ApifyTokenSpend } from "./apify-spend-model";
export type { ApifyTokenSpend } from "./apify-spend-model";
import { assertOrgMember, type ChatHistoryTurn } from "@noelle/runtime";
import type {
  WatchlistObjectiveKind,
  DiscoveryConfig,
  TargetingProposal,
  VaultEditProposal,
  PatternRulesPageInput,
  PatternAlertsPageInput,
  PatternRulesPage,
} from "@noelle/contracts";
import { SOCIAL_AGENT_ROLES, BusEventsQuerySchema, DiscoveryConfigSchema, parseVipSignal, parseRunSchedule, type VipSignal } from "@noelle/contracts";
import { XWhoamiOutSchema, type XWhoamiOut } from "@/lib/contracts";
import { noelleFetch } from "@/lib/api";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { pgOrgMembersClient, sql, readSql } from "@/lib/db";
import {
  loadVisibleAlerts,
  listPatternRules as readPatternRules,
  countPatternRules as readPatternCounts,
  validPatternScope,
  type PatternScope,
  type PatternAlertRow as StoredPatternAlertRow,
  type StoredPatternAlertsPage,
} from "@noelle/runtime/pattern-breaker-db";
import { getUserFromCookies } from "@/lib/auth-cookie";
import { cleanModelLabel, scrubBackendTokens } from "@/lib/model-label";
import { isAllSkipDraft } from "@/lib/is-skip-draft";
import { bodyForSelectedAngle, draftPayload, leadPayload, linkedinLeadPayload, redditLeadFields, sentReplyUrl } from "@/lib/payload-shapes";
import { parseStoredVaultEdit, publicVaultEditReceipt, type StoredVaultEdit, type VaultEditClientReceipt } from "@/lib/agent-chat/proposal";
import type {
  NoelleAgentInstance,
  NoelleApproval,
  NoelleDraft,
  NoelleLead,
  NoelleOrganization,
  NoelleOrgSpendMonth,
  NoelleSyncRun,
  SocialPlatform,
} from "@/lib/db-types";

/**
 * Read helpers for `noelle.*` tables.
 *
 * Phase 4 of tasks/supabase-to-gcp-migration.md: data lives in Cloud SQL
 * (Postgres 16), not in Supabase anymore. Every helper below queries via
 * the postgres.js `sql` template tagged client in `@/lib/db`. Auth still
 * flows through Supabase — `getCurrentUser()` keeps the Supabase
 * cookie-bound client because that's where sessions live.
 *
 * Tenancy: there's no RLS in Cloud SQL. Each helper that returns org-
 * scoped data calls `assertOrgMember()` (via the `pgOrgMembersClient()`
 * adapter) BEFORE the data query. Defense in depth: every read is gated
 * in TS.
 *
 * Naming: `getXForY` returns one row; `listXForY` returns many.
 */

/**
 * Resolve the currently signed-in Supabase auth user. Throws if there's no
 * session — every callsite that hits `assertOrgMember` needs a real user id.
 */
/**
 * Both helpers below use the verified identity owner in @/lib/auth-cookie.
 * It verifies an explicit JWT without entering SSR session-refresh locks.
 * The `sb` parameter is kept on internal helpers only for callers that still
 * pass it (it's unused for the auth path now).
 */
const requiredUserId = cache(async (): Promise<string> => {
  const user = await getUserFromCookies();
  if (!user) throw new Error("not signed in");
  return user.id;
});

async function getRequiredUserId(
  _sb?: Awaited<ReturnType<typeof createSupabaseServerClient>>,
): Promise<string> {
  // `_sb` is a legacy param (ignored — see note above). The cached inner keys
  // on no args; the identity owner also deduplicates verification per request jar.
  return requiredUserId();
}

/**
 * Per-request memoized membership guard. React `cache()` dedupes by
 * (orgId, userId) within one request render / server action, so the many
 * org-scoped read helpers that each guard with `assertOrgMember` share ONE
 * `org_members` round-trip instead of one apiece. Tenancy is unchanged: the
 * first call still asserts (and throws `OrgMembershipError` for a non-member);
 * later calls reuse that same settled promise.
 */
const assertMember = cache((orgId: string, userId: string) =>
  assertOrgMember(pgOrgMembersClient(), userId, orgId),
);

export async function getCurrentUser() {
  return getUserFromCookies();
}

export async function listOrgsForCurrentUser(): Promise<NoelleOrganization[]> {
  const sb = await createSupabaseServerClient();
  const userId = await getRequiredUserId(sb);
  // The inner join through `org_members` is itself the membership guard —
  // we only return orgs the user actually belongs to.
  const rows = await readSql<NoelleOrganization[]>`
    select o.*
    from noelle.organizations o
    join noelle.org_members m on m.org_id = o.id
    where m.user_id = ${userId}
    order by o.created_at asc
  `;
  return rows;
}

/**
 * Which X account the org's stored cookies post as (via api-vm /api/x/whoami).
 * Best-effort + per-request cached: returns `{ connected: false }` on any
 * error so callers can render "not connected" instead of throwing.
 */
export const getXAccount = cache(async (orgId: string): Promise<XWhoamiOut> => {
  try {
    const res = await noelleFetch<unknown>(
      `/api/x/whoami?org_id=${encodeURIComponent(orgId)}`,
    );
    return XWhoamiOutSchema.parse(res);
  } catch {
    return { connected: false };
  }
});

export const getOrgBySlug = cache(async (slug: string): Promise<NoelleOrganization | null> => {
  const userId = await getRequiredUserId();
  const rows = await readSql<NoelleOrganization[]>`
    select * from noelle.organizations where slug = ${slug} limit 1
  `;
  const org = rows[0];
  if (!org) return null;
  // No RLS in Cloud SQL — verify membership before returning a row that a
  // signed-in non-member could otherwise read by guessing the slug.
  await assertMember(org.id, userId);
  return org;
});

export const listAgentInstancesForOrg = cache(async (
  orgId: string,
): Promise<NoelleAgentInstance[]> => {
  const userId = await getRequiredUserId();
  await assertMember(orgId, userId);
  const rows = await readSql<NoelleAgentInstance[]>`
    select * from noelle.agent_instances
    where org_id = ${orgId}
      and status <> 'retired'
      and role = any(${[...SOCIAL_AGENT_ROLES]})
    order by role asc
  `;
  return rows;
});

export const getAgentInstance = cache(async (
  instanceId: string,
): Promise<NoelleAgentInstance | null> => {
  const userId = await getRequiredUserId();
  const rows = await readSql<NoelleAgentInstance[]>`
    select * from noelle.agent_instances where id = ${instanceId}
      and status <> 'retired'
      and role = any(${[...SOCIAL_AGENT_ROLES]})
    limit 1
  `;
  const inst = rows[0];
  if (!inst) return null;
  // Fetch first, then guard on the row's org_id. Returning null for
  // non-members would leak existence; throwing matches the original
  // "RLS would have refused" semantics callers already handle.
  await assertMember(inst.org_id, userId);
  return inst;
});

export interface InstanceTargeting {
  handles: string[];
  keywords: string[];
}

/**
 * What an agent instance is actively hunting for — its x_watchlist handles +
 * keywords. Drives the "Actively hunting for" summary on the Objective card and
 * the targeting page. Tenancy piggybacks on getAgentInstance (assertOrgMember).
 */
export async function getWatchlistForInstance(
  instanceId: string,
): Promise<InstanceTargeting> {
  const inst = await getAgentInstance(instanceId);
  if (!inst) return { handles: [], keywords: [] };
  const rows = await readSql<{ kind: "handle" | "keyword"; value: string }[]>`
    select kind, value
    from noelle.x_watchlist
    where agent_instance_id = ${inst.id} and org_id = ${inst.org_id}
    order by created_at asc
  `;
