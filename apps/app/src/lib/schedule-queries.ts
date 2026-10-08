import { cache } from "react";
import { assertOrgMember } from "@noelle/runtime";
import { pgOrgMembersClient, readSql as sql } from "@/lib/db";
import { getUserFromCookies } from "@/lib/auth-cookie";
import type { ScheduleSlotRow } from "@/components/posts/schedule-slots";
export type { ScheduleSlotRow } from "@/components/posts/schedule-slots";

/**
 * Read helpers for the Schedule calendar (noelle.content_schedule_slots).
 * Tenancy: Cloud SQL has no RLS, so every helper asserts org membership before
 * returning rows (same contract as posts-queries.ts / queries.ts).
 */

const requiredUserId = cache(async (): Promise<string> => {
  const user = await getUserFromCookies();
  if (!user) throw new Error("not signed in");
  return user.id;
});

async function assertMember(orgId: string, userId: string): Promise<void> {
  await assertOrgMember(pgOrgMembersClient(), userId, orgId);
}

/**
 * Slots in `[from, to)` for an org, optionally one platform. `skipped` slots are
 * hidden. Joins the bound draft/idea for the calendar chip preview.
 */
export const listScheduleSlotsForOrg = cache(async (
  orgId: string,
  range: { from: string; to: string },
  platform: string | null = null,
): Promise<ScheduleSlotRow[]> => {
  const userId = await requiredUserId();
  await assertMember(orgId, userId);
  const rows = await sql<ScheduleSlotRow[]>`
    select
      s.id,
      s.agent_instance_id,
      s.platform,
      to_char(s.slot_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as slot_at,
      s.status,
      s.idea_id,
      s.draft_id,
      s.auto_publish,
      s.window_source,
      s.batch_id,
      s.target_kind,
      s.posted_url,
      to_char(s.published_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as published_at,
      coalesce(d.final_body, d.body, i.hook) as preview,
      coalesce(d.hook, i.hook) as hook
    from noelle.content_schedule_slots s
    join noelle.agent_instances ai on ai.id = s.agent_instance_id and ai.org_id = s.org_id
    left join noelle.post_drafts d on d.id = s.draft_id
      and d.org_id = s.org_id and d.agent_instance_id = s.agent_instance_id and d.platform = s.platform
      and (s.idea_id is null or d.idea_id = s.idea_id)
      and exists (select 1 from noelle.post_ideas di where di.id = d.idea_id
        and di.org_id = d.org_id and di.agent_instance_id = d.agent_instance_id)
    left join noelle.post_ideas i on i.id = coalesce(s.idea_id, d.idea_id)
      and i.org_id = s.org_id and i.agent_instance_id = s.agent_instance_id
      and (s.draft_id is null or d.id is not null)
    where s.org_id = ${orgId}
      and s.status <> 'skipped'
      and s.slot_at >= ${range.from}
      and s.slot_at < ${range.to}
      and (${platform}::text is null or s.platform = ${platform})
    order by s.slot_at asc
  `;
  return rows;
});

/** The agent instance id for a role in an org (the Compose target), or null. */
export const getInstanceIdForRole = cache(async (orgId: string, role: string): Promise<string | null> => {
  const userId = await requiredUserId();
  await assertMember(orgId, userId);
  const rows = await sql<Array<{ id: string }>>`
    select id from noelle.agent_instances where org_id = ${orgId} and role = ${role} limit 1
  `;
  return rows[0]?.id ?? null;
});

export interface ComposeJobRow {
  id: string;
  status: string;
  items_total: number;
  items_drafted: number;
  prompt: string | null;
  created_at: string;
}

/** Recent Compose batches for an instance, with how many slots are drafted/published. */
export const listComposeJobsForInstance = cache(async (orgId: string, instanceId: string): Promise<ComposeJobRow[]> => {
  const userId = await requiredUserId();
  await assertMember(orgId, userId);
  return await sql<ComposeJobRow[]>`
    select
      j.id, j.status, j.items_total, j.prompt,
      to_char(j.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as created_at,
      (
        select count(*)::int from noelle.content_schedule_slots s
        where s.batch_id = j.id and s.status in ('ready', 'publishing', 'published')
          and s.org_id = j.org_id and s.agent_instance_id = j.agent_instance_id
      ) as items_drafted
    from noelle.agent_compose_jobs j
    join noelle.agent_instances ai on ai.id = j.agent_instance_id and ai.org_id = j.org_id
    where j.org_id = ${orgId} and j.agent_instance_id = ${instanceId}
    order by j.created_at desc
    limit 8
  `;
});

export interface TrendRef {
  author: string | null;
  note: string | null;
  url: string | null;
}

/** Recent high-engagement posts that have fuelled this agent's ideas — the
 *  Trending "fuel" feed (deduped, from post_ideas.inspiration_refs). */
export const getTrendingRefs = cache(async (orgId: string, instanceId: string): Promise<TrendRef[]> => {
  const userId = await requiredUserId();
  await assertMember(orgId, userId);
  const rows = await sql<Array<{ inspiration_refs: unknown }>>`
    select i.inspiration_refs from noelle.post_ideas i
    join noelle.agent_instances ai on ai.id = i.agent_instance_id and ai.org_id = i.org_id
    where i.org_id = ${orgId} and i.agent_instance_id = ${instanceId}
      and i.inspiration_refs is not null and i.inspiration_refs <> '[]'::jsonb
    order by i.created_at desc
    limit 40
  `;
  const out: TrendRef[] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    const refs = Array.isArray(r.inspiration_refs) ? r.inspiration_refs : [];
    for (const ref of refs) {
      if (!ref || typeof ref !== "object") continue;
      const o = ref as { author?: unknown; note?: unknown; url?: unknown };
      const author = typeof o.author === "string" ? o.author : null;
      const note = typeof o.note === "string" ? o.note : null;
      const url = typeof o.url === "string" ? o.url : null;
      const key = url ?? note ?? "";
      if (!key || seen.has(key)) continue;
      seen.add(key);
      out.push({ author, note, url });
      if (out.length >= 12) return out;
    }
  }
  return out;
});

/** The raw brand_config jsonb for an instance (caller runs parseBrandConfig). */
export const getInstanceBrandConfig = cache(async (orgId: string, instanceId: string): Promise<unknown> => {
  const userId = await requiredUserId();
  await assertMember(orgId, userId);
  const rows = await sql<Array<{ brand_config: unknown }>>`
    select brand_config from noelle.agent_instances where id = ${instanceId} and org_id = ${orgId} limit 1
  `;
  return rows[0]?.brand_config ?? {};
});

export interface AgentPerformance {
  byStatus: { status: string; n: number }[];
  scheduledAhead: number;
  publishedAllTime: number;
  publishedThisWeek: number;
  draftsThisWeek: number;
  /** 14-day daily drafts-created series (oldest→newest), for the trend. */
  draftTrend: { day: string; n: number }[];
}

/** Per-agent activity metrics for the Performance dashboard. */
export const getAgentPerformance = cache(async (orgId: string, instanceId: string): Promise<AgentPerformance> => {
  const userId = await requiredUserId();
  await assertMember(orgId, userId);
  const [byStatus, drafts, pubWeek, pubAll, trend] = await Promise.all([
    sql<Array<{ status: string; n: number }>>`
      select s.status, count(*)::int as n from noelle.content_schedule_slots s
      join noelle.agent_instances ai on ai.id = s.agent_instance_id and ai.org_id = s.org_id
      where s.org_id = ${orgId} and s.agent_instance_id = ${instanceId} and s.status <> 'skipped'
      group by s.status
    `,
    sql<Array<{ n: number }>>`
      select count(*)::int as n from noelle.post_drafts d
      join noelle.agent_instances ai on ai.id = d.agent_instance_id and ai.org_id = d.org_id
      where d.org_id = ${orgId} and d.agent_instance_id = ${instanceId} and d.created_at >= now() - interval '7 days'
    `,
    sql<Array<{ n: number }>>`
      select count(*)::int as n from noelle.content_schedule_slots s
      join noelle.agent_instances ai on ai.id = s.agent_instance_id and ai.org_id = s.org_id
      where s.org_id = ${orgId} and s.agent_instance_id = ${instanceId} and s.status = 'published' and s.published_at >= now() - interval '7 days'
    `,
    sql<Array<{ n: number }>>`
      select count(*)::int as n from noelle.content_schedule_slots s
      join noelle.agent_instances ai on ai.id = s.agent_instance_id and ai.org_id = s.org_id
      where s.org_id = ${orgId} and s.agent_instance_id = ${instanceId} and s.status = 'published'
    `,
    sql<Array<{ day: string; n: number }>>`
      select to_char(d.created_at at time zone 'UTC', 'YYYY-MM-DD') as day, count(*)::int as n
      from noelle.post_drafts d
      join noelle.agent_instances ai on ai.id = d.agent_instance_id and ai.org_id = d.org_id
