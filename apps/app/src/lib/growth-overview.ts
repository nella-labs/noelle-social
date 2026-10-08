import "server-only";
import { assertOrgMember } from "@noelle/runtime";
import { SOCIAL_AGENT_ROLES } from "@noelle/contracts";
import { getUserFromCookies } from "@/lib/auth-cookie";
import { pgOrgMembersClient, readSql as sql } from "@/lib/db";
import {
  countPendingApprovalsForOrg, countPendingLinkedInApprovals, countPendingRedditApprovals,
  getSentStatsByAgent, getSentDaily14ByAgent, listAgentInstancesForOrg,
} from "@/lib/queries";
import { getPublishedPostPerformance, listScheduleSlotsForOrg } from "@/lib/schedule-queries";

export type Measurement<T> = { status: "ready"; value: T } | { status: "unavailable" };

export async function measure<T>(load: () => Promise<T>): Promise<Measurement<T>> {
  try { return { status: "ready", value: await load() }; }
  catch { return { status: "unavailable" }; }
}

export interface ContentQueueCounts { ideas: number; drafts: number; ready: number; }

async function getContentQueueCounts(orgId: string): Promise<ContentQueueCounts> {
  const user = await getUserFromCookies();
  if (!user) throw new Error("not signed in");
  await assertOrgMember(pgOrgMembersClient(), user.id, orgId);
  const rows = await sql<ContentQueueCounts[]>`
    with latest as (
      select distinct on (d.idea_id, d.platform) d.status
      from noelle.post_drafts d
      join noelle.post_ideas i on i.id=d.idea_id and i.org_id=d.org_id and i.agent_instance_id=d.agent_instance_id
      join noelle.agent_instances ai on ai.id=d.agent_instance_id and ai.org_id=d.org_id
      where d.org_id=${orgId} and ai.status <> 'retired'
        and ai.role = any(${[...SOCIAL_AGENT_ROLES]})
        and d.status in ('draft','ready','published')
      order by d.idea_id,d.platform,d.created_at desc
    )
    select
      (select count(*)::int from noelle.post_ideas i
        join noelle.agent_instances ai on ai.id=i.agent_instance_id and ai.org_id=i.org_id
        where i.org_id=${orgId} and i.status='proposed' and ai.status <> 'retired'
          and ai.role = any(${[...SOCIAL_AGENT_ROLES]})) as ideas,
      count(*) filter (where status='draft')::int as drafts,
      count(*) filter (where status='ready')::int as ready
    from latest`;
  return rows[0] ?? { ideas: 0, drafts: 0, ready: 0 };
}

export async function loadGrowthOverview(orgId: string, now = new Date()) {
  const from = now.toISOString();
  const to = new Date(now.getTime() + 7 * 86_400_000).toISOString();
  const [channels, sent, daily, scheduled, content] = await Promise.all([
    measure(() => listAgentInstancesForOrg(orgId)),
    measure(() => getSentStatsByAgent(orgId)),
    measure(() => getSentDaily14ByAgent(orgId)),
    measure(() => listScheduleSlotsForOrg(orgId, { from, to })),
    measure(() => getContentQueueCounts(orgId)),
  ]);
  const pending = channels.status === "ready" ? await measure(async () => {
    const linkedin = channels.value.find((instance) => instance.role === "linkedin_intern");
    const reddit = channels.value.find((instance) => instance.role === "reddit_intern");
    const counts = await Promise.all([
      countPendingApprovalsForOrg(orgId),
      linkedin ? countPendingLinkedInApprovals(linkedin.id) : 0,
      reddit ? countPendingRedditApprovals(reddit.id) : 0,
    ]);
    return counts.reduce((sum, count) => sum + count, 0);
  }) : { status: "unavailable" } as const;
  const x = channels.status === "ready" ? channels.value.find((instance) => instance.role === "x_intern") : null;
  const performance = channels.status === "unavailable" ? { status: "unavailable" } as const
    : x ? await measure(() => getPublishedPostPerformance(orgId, x.id)) : null;
  return { channels, sent, daily, scheduled, content, pending, performance, from, to };
}

export type GrowthOverviewData = Awaited<ReturnType<typeof loadGrowthOverview>>;
