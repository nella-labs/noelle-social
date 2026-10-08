import "server-only";

/**
 * The only module in `lib/guided/` that touches Postgres.
 *
 * Loads one `GuidedSignals` snapshot per render. Every field comes from a table
 * that already exists — the guided workflow adds no migration, which matters
 * because `infra/cloudsql/` has no migration runner and no ledger (files are
 * hand-applied with `psql -f`). A column this UI depended on would 500 every
 * dashboard read until someone ran it by hand.
 *
 * Tenancy: Cloud SQL has no RLS and no `auth.uid()`. `assertOrgMember` below is
 * the only thing stopping a signed-in user from reading another tenant's setup
 * state by guessing an org id. See CLAUDE.md §5.
 */

import { approvalMemoryJoins, assertOrgMember, tenantInstanceSql, trimMemorySql } from "@noelle/runtime";
import { pgOrgMembersClient, sql } from "@/lib/db";
import { getUserFromCookies } from "@/lib/auth-cookie";
import { INTERN_ROLES, type GuidedAgentSignal, type GuidedSignals, type InternRole } from "./types";

/**
 * Targeting lives in a different table per role, all keyed by `agent_instance_id`.
 * An intern with zero rows in its table discovers nothing, forever — which is the
 * single most common reason a new operator sees an empty approvals queue.
 *
 * Resolved in one static query rather than a per-agent round trip. The role→table
 * mapping is a SQL `case`, not string interpolation, so no table name is ever
 * built at runtime.
 */
async function loadAgents(orgId: string): Promise<GuidedAgentSignal[]> {
  const rows = await sql<
    Array<{
      id: string;
      role: string;
      display_name: string | null;
      status: string;
      reply_send_enabled: boolean | null;
      has_targeting: boolean;
    }>
  >`
    select
      ai.id, ai.role, ai.display_name, ai.status, ai.reply_send_enabled,
      case ai.role
        when 'x_intern' then
             exists (select 1 from noelle.x_watchlist w        where w.agent_instance_id = ai.id and w.org_id = ai.org_id)
          or exists (select 1 from noelle.x_watchlist_people p  where p.agent_instance_id = ai.id and p.org_id = ai.org_id)
        when 'linkedin_intern' then
             exists (select 1 from noelle.linkedin_watchlist w        where w.agent_instance_id = ai.id and w.org_id = ai.org_id)
          or exists (select 1 from noelle.linkedin_watchlist_people p where p.agent_instance_id = ai.id and p.org_id = ai.org_id)
        when 'reddit_intern' then
             exists (select 1 from noelle.reddit_watchlist r where r.agent_instance_id = ai.id and r.org_id = ai.org_id)
        when 'video_intern' then
             exists (select 1 from noelle.video_watchlist_sources s where s.agent_instance_id = ai.id and s.org_id = ai.org_id and s.enabled)
          or exists (select 1 from noelle.video_watchlist_niches n  where n.agent_instance_id = ai.id and n.org_id = ai.org_id and n.enabled)
        else false
      end as has_targeting
    from noelle.agent_instances ai
    where ai.org_id = ${orgId}
      and ai.role = any(${INTERN_ROLES as unknown as string[]})
      and ai.status <> 'retired'
  `;

  return rows.map((r) => ({
    role: r.role as InternRole,
    instanceId: r.id,
    displayName: r.display_name,
    status: r.status,
    hasTargeting: Boolean(r.has_targeting),
    replySendEnabled: Boolean(r.reply_send_enabled),
  }));
}

/**
 * A token that is present but unusable is worse than no token: the step would
 * read "done" while discovery silently starves.
 *
 * "Usable" must match what the WORKERS actually read, not what the Connections
 * page lists. Every intern's resolver (`apps/*-intern/src/lib/connections-db.ts`)
 * gates on `active and in_use and invalid_at is null`, and every token added
 * through the dashboard lands SPARE (`in_use = false`; see `addApifyConnectionsBulk`)
 * until the operator promotes it. Omitting `in_use` here would mark the step done
 * the instant a token is pasted, while no worker could fetch a single post.
 */
async function hasLiveApifyToken(orgId: string): Promise<boolean> {
  const rows = await sql<Array<{ ok: boolean }>>`
    select exists (
      select 1 from noelle.connections
      where org_id = ${orgId}
        and kind = 'apify'
        and active
        and in_use
        and invalid_at is null
        -- Same availability test the workers use. An exhausted token with no
        -- scheduled retry stays unavailable: retry_at <= now() is NULL, not
        -- true. Adding "or retry_at is null" would tick the step for a token
        -- no worker will ever pick up.
        and (exhausted_at is null or retry_at <= now())
    ) as ok
  `;
  return Boolean(rows[0]?.ok);
}

async function loadPipeline(orgId: string) {
  const rows = await sql<
    Array<{ discovered_any: boolean; drafted_any: boolean; actioned_any: boolean }>
  >`
    select
      exists (select 1 from noelle.leads l where l.org_id = ${orgId}
        and ${tenantInstanceSql(sql, sql`l.org_id`, sql`l.agent_instance_id`)}) as discovered_any,
      exists (select 1 from noelle.drafts d join noelle.leads l on l.id = d.lead_id and l.org_id = d.org_id
        where d.org_id = ${orgId}
          and ${tenantInstanceSql(sql, sql`l.org_id`, sql`l.agent_instance_id`)}) as drafted_any,
      exists (
        select 1 from noelle.approvals a ${approvalMemoryJoins(sql)}
        where a.org_id = ${orgId} and a.status in ('approved', 'sent', 'skipped')
          and ${trimMemorySql(sql, sql`a.decided_by`)} <> ''
          and a.decided_by not in ('auto-send', 'automatic-review')
          and lower(a.decided_by) <> a.org_id::text
      ) as actioned_any
  `;
  return {
    discoveredAny: Boolean(rows[0]?.discovered_any),
    draftedAny: Boolean(rows[0]?.drafted_any),
    actionedAny: Boolean(rows[0]?.actioned_any),
  };
}

async function loadVaultStage(orgId: string): Promise<GuidedSignals["vaultStage"]> {
  const rows = await sql<Array<{ wizard_stage: string | null }>>`
    select wizard_stage from noelle.vaults where org_id = ${orgId} limit 1
  `;
  const stage = rows[0]?.wizard_stage ?? null;
  return stage === "light" || stage === "medium" || stage === "rich" ? stage : null;
}

interface LoadArgs {
  orgId: string;
  /** Injected by the caller so we don't duplicate its de-duplicating logic. */
  pendingApprovals: number;
  /** Cookie/api-vm backed; X posting creds are not a `noelle.*` row. */
  xPostingReady: boolean;
}

/**
 * Load one coherent snapshot. A failed required read rejects so the shared
 * loader can show unavailable without reporting an empty organization or
 * taking the rest of the dashboard down.
 */
export async function loadGuidedSignals({
  orgId,
  pendingApprovals,
  xPostingReady,
}: LoadArgs): Promise<GuidedSignals> {
  const user = await getUserFromCookies();
  if (!user) throw new Error("Guided setup unavailable without a current user");
  await assertOrgMember(pgOrgMembersClient(), user.id, orgId);

  const [vaultStage, hasApifyToken, agents, pipeline] = await Promise.all([
    loadVaultStage(orgId),
    hasLiveApifyToken(orgId),
    loadAgents(orgId),
    loadPipeline(orgId),
  ]);

  return {
    vaultStage,
    hasApifyToken,
    agents,
    discoveredAny: pipeline.discoveredAny,
    draftedAny: pipeline.draftedAny,
    actionedAny: pipeline.actionedAny,
    pendingApprovals,
    xPostingReady,
  };
}
