import { SOCIAL_AGENT_ROLES } from "@noelle/runtime/types";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { NoelleError, type NoelleContext } from "../context.js";
import type { ToolModule, ToolResult } from "../types.js";
import { guard, mdTable, text } from "../result.js";
import { ORG_PROP, capRelevantCents, currentMonthIso, infraCents, limitOf, optStr, resolveAgentInstance } from "./_shared.js";
import { readPgBudgetHolds, type BudgetHoldsCursor } from "@noelle/runtime/pg-budget-holds";

// Org discovery + high-level status. These are the entry points: run
// noelle_list_orgs to see what you can operate, then most other tools default
// to NOELLE_MCP_ORG or take an `org` argument.

const tools: Tool[] = [
  {
    name: "noelle_list_orgs",
    description:
      "List all Noelle organizations in the database with their slug, plan, agent count, and pending-approval count. Use this to discover which org to pass as `org` (or to set NOELLE_MCP_ORG).",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "noelle_get_org",
    description:
      "Get one organization's details, counts, cached monthly accounting across subscription pots, and configured combined agent cap. Use noelle_budget_holds for unresolved call capacity.",
    inputSchema: { type: "object", properties: { org: ORG_PROP } },
  },
  {
    name: "noelle_status",
    description:
      "Operational snapshot: agent status and Friendly DM switches, pending approvals, messages marked sent, leads discovered today, and cached monthly accounting. Use noelle_budget_holds for unresolved call capacity.",
    inputSchema: { type: "object", properties: { org: ORG_PROP } },
  },
  {
    name: "noelle_budget_holds",
    description: "Read unresolved call reservations with admission estimates, recorded receipt accounting and retained capacity for the current budget period. Shows common model, separate Codex and infrastructure pots. Optional agent selector and cursor pagination; no release action.",
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    inputSchema: { type: "object", additionalProperties: false, properties: {
      org: ORG_PROP,
      role: { type: "string", description: "Optional agent role. Omit both selectors for the whole organization." },
      agentInstanceId: { type: "string", description: "Optional agent instance UUID belonging to this organization." },
      limit: { type: "integer", minimum: 1, maximum: 100, default: 50 },
      cursor: { type: "object", additionalProperties: false, required: ["admittedAt", "id"], properties: {
        admittedAt: { type: "string", description: "Copy the exact timestamp from the preceding next cursor." },
        id: { type: "string", description: "Copy the reservation UUID from the preceding next cursor." },
      } },
    } },
  },
];

function cachedAccountingLines(rows: Array<{ bucket: string; cents: string }>, capCents: number): string[] {
  return [
    `- **cached monthly accounting (model and subscription pots combined):** $${(capRelevantCents(rows) / 100).toFixed(2)}`,
    `- **combined configured agent cap:** $${(capCents / 100).toFixed(2)}`,
    "- **unresolved capacity:** use `noelle_budget_holds` for current-period receipts and retained estimates.",
  ];
}

async function budgetHolds(args: Record<string, unknown>, ctx: NoelleContext): Promise<ToolResult> {
  const org = await ctx.resolveOrg(optStr(args, "org"));
  const selectedId = optStr(args, "agentInstanceId");
  const role = optStr(args, "role");
  for (const key of ["agentInstanceId", "role"] as const) {
    if (args[key] !== undefined && !optStr(args, key)) throw new NoelleError(`Invalid ${key}`);
  }
  const instance = selectedId || role ? await resolveAgentInstance(ctx, org.orgId, args) : null;
  if (role && instance?.role !== role) throw new NoelleError("The selected instance does not match the requested role.");
  const page = await readPgBudgetHolds(ctx.sql, { orgId: org.orgId,
    ...(instance ? { instanceId: instance.id } : {}), limit: limitOf(args, 50, 100),
    ...(args.cursor === undefined ? {} : { cursor: args.cursor as BudgetHoldsCursor }),
  });
  const totals = ["common", "codex", "infrastructure"].map((pot) => {
    const rows = page.holds.filter((r) => r.pot === pot);
    return [pot, rows.reduce((n, r) => n + r.recordedPeriodCents, 0), rows.reduce((n, r) => n + r.heldCapacityCents, 0)];
  });
  return text([
    `## ${org.name} — unresolved budget calls`,
    `Period: **${page.period}**, starting ${page.periodStartedAt}. Scope: ${instance?.id ?? "whole organization"}.`,
    "**Page totals (cents; this page only)**",
    mdTable(["pot", "recorded this period", "held estimate"], totals),
    mdTable(["reservation", "instance", "worker / bucket", "engine / model", "admitted", "admission estimate", "receipt / status", "receipt cents / basis", "period recorded", "held capacity"],
      page.holds.map((r) => [r.id, r.instanceId ?? "deleted instance", `${r.worker} / ${r.bucket}`,
        `${r.engine} / ${r.model}`, r.admittedAt, r.estimatedCents,
        r.receipt ? `${r.receipt.id} / ${r.receipt.status}` : "unavailable",
        r.receipt ? `${r.receipt.cents} / ${r.receipt.costBasis}` : "unknown", r.recordedPeriodCents, r.heldCapacityCents])),
    "Retained estimates remain reserved until their accounting outcome is reconciled. This tool only reads them.",
    page.nextCursor ? `Next cursor: ${JSON.stringify(page.nextCursor)}` : "End of results.",
  ].join("\n\n"));
}

async function listOrgs(ctx: NoelleContext): Promise<ToolResult> {
  const rows = await ctx.sql<
    Array<{
      id: string;
      slug: string;
      name: string;
      plan: string;
      llm_backend: string;
      created_at: string;
      agents: number;
      pending: number;
    }>
  >`
    select o.id, o.slug, o.name, o.plan, o.llm_backend, o.created_at::text as created_at,
      (select count(*)::int from noelle.agent_instances a where a.org_id = o.id and a.role = any(${[...SOCIAL_AGENT_ROLES]}::text[]) and a.status <> 'retired') as agents,
      (select count(*)::int from noelle.approvals ap where ap.org_id = o.id and ap.status = 'pending') as pending
    from noelle.organizations o
    order by o.created_at asc`;

  const table = mdTable(
    ["slug", "name", "plan", "agents", "pending", "id"],
    rows.map((r) => [r.slug, r.name, r.plan, r.agents, r.pending, r.id]),
  );
  return text(`**${rows.length} organization(s)**\n\n${table}`);
}

async function getOrg(args: Record<string, unknown>, ctx: NoelleContext): Promise<ToolResult> {
  const org = await ctx.resolveOrg(typeof args.org === "string" ? args.org : undefined);

  const [meta] = await ctx.sql<
    Array<{ plan: string; llm_backend: string; created_at: string }>
  >`select plan, llm_backend, created_at::text as created_at from noelle.organizations where id = ${org.orgId}`;

  const [counts] = await ctx.sql<
    Array<{
      agents: number;
      members: number;
      pending_approvals: number;
      leads: number;
      budget_cap_cents: number;
    }>
  >`
    select
      (select count(*)::int from noelle.agent_instances where org_id = ${org.orgId} and role = any(${[...SOCIAL_AGENT_ROLES]}::text[]) and status <> 'retired') as agents,
      (select count(*)::int from noelle.org_members where org_id = ${org.orgId}) as members,
      (select count(*)::int from noelle.approvals where org_id = ${org.orgId} and status = 'pending') as pending_approvals,
      (select count(*)::int from noelle.leads where org_id = ${org.orgId}) as leads,
      (select coalesce(sum(budget_cap_cents), 0)::int from noelle.agent_instances where org_id = ${org.orgId} and role = any(${[...SOCIAL_AGENT_ROLES]}::text[]) and status <> 'retired') as budget_cap_cents`;

  // The monthly cache combines subscription pots; it cannot establish live capacity.
  const spendRows = await ctx.sql<Array<{ bucket: string; cents: string }>>`
    select bucket, coalesce(sum(cents), 0)::bigint as cents
    from noelle.org_spend_month where org_id = ${org.orgId} and month = ${currentMonthIso()}
    group by bucket`;

  const infraUsd = (infraCents(spendRows) / 100).toFixed(2);

  const body = [
    `## ${org.name}  \`${org.slug}\``,
    `- **id:** ${org.orgId}`,
    `- **plan:** ${meta?.plan ?? "?"} · **llm backend:** ${meta?.llm_backend ?? "?"}`,
    `- **created:** ${meta?.created_at ?? "?"}`,
    `- **agents:** ${counts?.agents ?? 0} · **members:** ${counts?.members ?? 0}`,
    `- **pending approvals:** ${counts?.pending_approvals ?? 0} · **total leads:** ${counts?.leads ?? 0}`,
    ...cachedAccountingLines(spendRows, counts?.budget_cap_cents ?? 0),
    `- **infra (Apify + X-API, not capped):** $${infraUsd}`,
  ].join("\n");
  return text(body);
}

async function status(args: Record<string, unknown>, ctx: NoelleContext): Promise<ToolResult> {
  const org = await ctx.resolveOrg(typeof args.org === "string" ? args.org : undefined);

  const agents = await ctx.sql<
    Array<{
      role: string;
      status: string;
      display_name: string | null;
      discovery_enabled: boolean;
      classifier_enabled: boolean;
      drafter_enabled: boolean;
      send_enabled: boolean;
      friendly_dms_enabled: boolean;
    }>
  >`
    select role, status, display_name, discovery_enabled, classifier_enabled, drafter_enabled, send_enabled,
      coalesce(lane_config #> '{dms,relationship_dms_enabled}' = 'true'::jsonb, false) as friendly_dms_enabled
    from noelle.agent_instances where org_id = ${org.orgId}
      and role = any(${[...SOCIAL_AGENT_ROLES]}::text[]) and status <> 'retired' order by role asc`;

  const pending = await ctx.sql<Array<{ platform: string; replies: number; dms: number }>>`
    select coalesce(l.platform, 'x') as platform,
      count(distinct coalesce(l.id::text, a.id::text)) filter (where coalesce(d.payload->>'kind','reply') <> 'dm')::int as replies,
      count(*) filter (where d.payload->>'kind' = 'dm')::int as dms
    from noelle.approvals a
    left join noelle.drafts d on d.id = a.draft_id
    left join noelle.leads l on l.id = d.lead_id
    where a.org_id = ${org.orgId} and a.status = 'pending'
      and (l.external_id is null or l.external_id not like 'synthetic-%')
    group by coalesce(l.platform, 'x') order by platform`;

  const [sent] = await ctx.sql<Array<{ n: number }>>`
    select count(*)::int as n from noelle.approvals
    where org_id = ${org.orgId} and status = 'sent' and decided_at >= now() - interval '30 days'`;

  const [leadsToday] = await ctx.sql<Array<{ n: number }>>`
    select count(*)::int as n from noelle.leads
    where org_id = ${org.orgId} and created_at >= date_trunc('day', now())`;

  // Cached monthly accounting is separate from current admission pressure.
  const spendRows = await ctx.sql<Array<{ bucket: string; cents: string }>>`
    select bucket, coalesce(sum(cents), 0)::bigint as cents
    from noelle.org_spend_month where org_id = ${org.orgId} and month = ${currentMonthIso()}
    group by bucket`;
  const [cap] = await ctx.sql<Array<{ cents: number }>>`
    select coalesce(sum(budget_cap_cents), 0)::int as cents from noelle.agent_instances where org_id = ${org.orgId}
      and role = any(${[...SOCIAL_AGENT_ROLES]}::text[]) and status <> 'retired'`;

  const lanes = (a: (typeof agents)[number]) =>
    [
      a.discovery_enabled ? "disc" : null,
      a.classifier_enabled ? "class" : null,
      a.drafter_enabled ? "draft" : null,
      a.send_enabled ? "send" : null,
    ]
      .filter(Boolean)
      .join("+") || "—";

  const agentTable = mdTable(
    ["role", "name", "status", "lanes", "Friendly DMs"],
    agents.map((a) => [a.role, a.display_name ?? "—", a.status, lanes(a), a.friendly_dms_enabled ? "on" : "off"]),
  );

  const body = [
    `## ${org.name} — status`,
    "",
    "**Pending approvals**",
    mdTable(["platform", "reply threads", "DMs"], pending.map((p) => [p.platform, p.replies, p.dms])),
    `- **messages marked sent (30d):** ${sent?.n ?? 0}`,
    `- **leads today:** ${leadsToday?.n ?? 0}`,
    ...cachedAccountingLines(spendRows, cap?.cents ?? 0),
    "",
    `### Agents (${agents.length})`,
    agentTable,
  ].join("\n");
  return text(body);
}

async function handle(
  name: string,
  args: Record<string, unknown>,
  ctx: NoelleContext,
): Promise<ToolResult | null> {
  switch (name) {
    case "noelle_list_orgs":
      return guard(() => listOrgs(ctx));
    case "noelle_get_org":
      return guard(() => getOrg(args, ctx));
    case "noelle_status":
      return guard(() => status(args, ctx));
    case "noelle_budget_holds":
      return guard(() => budgetHolds(args, ctx));
    default:
      return null;
  }
}

export const orgsModule: ToolModule = { tools, handle };
