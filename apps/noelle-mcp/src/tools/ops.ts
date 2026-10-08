import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { NoelleContext } from "../context.js";
import type { ToolModule, ToolResult } from "../types.js";
import { ago, guard, mdTable, text, truncate } from "../result.js";
import { LIMIT_PROP, ORG_PROP, capRelevantCents, currentMonthIso, infraCents, limitOf, optStr } from "./_shared.js";

// Ops = spend + background-worker health. Spend is org-scoped (org_spend_month).
// Worker runs are GLOBAL — noelle.worker_runs has no org_id — so those tools
// report across the whole deployment, not just one org.

const tools: Tool[] = [
  {
    name: "noelle_get_spend",
    description:
      "Org LLM spend for a month vs. the combined agent budget cap, plus a per-bucket breakdown. Apify + X-API infra buckets are shown for visibility but EXCLUDED from the cap-relevant total (they never count toward the cap). Defaults to the current month.",
    inputSchema: {
      type: "object",
      properties: {
        org: ORG_PROP,
        month: {
          type: "string",
          description: "Month as 'YYYY-MM-01'. Defaults to the current month.",
        },
      },
    },
  },
  {
    name: "noelle_recent_worker_runs",
    description:
      "Recent background worker runs (GLOBAL across all orgs — noelle.worker_runs is NOT org-scoped): worker, when it started/finished, rows processed, and any error. Most recent first.",
    inputSchema: { type: "object", properties: { limit: LIMIT_PROP } },
  },
  {
    name: "noelle_active_workers",
    description:
      "Workers currently running (started in the last 15 minutes, not yet finished, no error). GLOBAL across all orgs — noelle.worker_runs is NOT org-scoped.",
    inputSchema: { type: "object", properties: {} },
  },
];

async function getSpend(args: Record<string, unknown>, ctx: NoelleContext): Promise<ToolResult> {
  const org = await ctx.resolveOrg(optStr(args, "org"));
  const month = optStr(args, "month") ?? currentMonthIso();

  const buckets = await ctx.sql<Array<{ bucket: string; cents: string }>>`
    select bucket, coalesce(sum(cents),0)::bigint as cents from noelle.org_spend_month
    where org_id = ${org.orgId} and month = ${month} group by bucket order by cents desc`;

  const [cap] = await ctx.sql<Array<{ cents: number }>>`
    select coalesce(sum(budget_cap_cents),0)::int as cents from noelle.agent_instances where org_id = ${org.orgId}`;

  const llmCents = capRelevantCents(buckets);
  const infra = infraCents(buckets);
  const capCents = cap?.cents ?? 0;

  const table = mdTable(
    ["bucket", "spend"],
    buckets.map((b) => [b.bucket, `$${(Number(b.cents) / 100).toFixed(2)}`]),
  );

  const body = [
    `## ${org.name} — spend for ${month}`,
    "",
    table,
    "",
    `- **LLM spend (counts toward cap):** $${(llmCents / 100).toFixed(2)} / $${(capCents / 100).toFixed(2)} cap`,
    `- **infra (Apify + X-API, not capped):** $${(infra / 100).toFixed(2)}`,
  ].join("\n");
  return text(body);
}

async function recentWorkerRuns(
  args: Record<string, unknown>,
  ctx: NoelleContext,
): Promise<ToolResult> {
  const limit = limitOf(args);
  const rows = await ctx.sql<
    Array<{
      id: string;
      worker: string;
      instance_id: string | null;
      started_at: string | null;
      finished_at: string | null;
      error: string | null;
      rows_processed: number | null;
    }>
  >`
    select id, worker, instance_id, started_at::text, finished_at::text, error, rows_processed
    from noelle.worker_runs
    order by coalesce(finished_at, started_at) desc
    limit ${limit}`;

  const table = mdTable(
    ["worker", "started", "finished", "rows", "error"],
    rows.map((r) => [
      r.worker,
      ago(r.started_at),
      r.finished_at ? ago(r.finished_at) : "running",
      r.rows_processed ?? "—",
      r.error ? truncate(r.error, 60) : "",
    ]),
  );
  return text(`**${rows.length} recent worker run(s)** (global, all orgs)\n\n${table}`);
}

async function activeWorkers(ctx: NoelleContext): Promise<ToolResult> {
  const rows = await ctx.sql<Array<{ worker: string }>>`
    select distinct worker from noelle.worker_runs
    where finished_at is null and error is null and started_at > now() - interval '15 minutes'
    order by worker`;

  if (rows.length === 0)
    return text("No workers active in the last 15 minutes (global, all orgs).");
  return text(
    `**${rows.length} active worker(s)** (global, all orgs; last 15 min):\n\n${rows
      .map((r) => `- ${r.worker}`)
      .join("\n")}`,
  );
}

async function handle(
  name: string,
  args: Record<string, unknown>,
  ctx: NoelleContext,
): Promise<ToolResult | null> {
  switch (name) {
    case "noelle_get_spend":
      return guard(() => getSpend(args, ctx));
    case "noelle_recent_worker_runs":
      return guard(() => recentWorkerRuns(args, ctx));
    case "noelle_active_workers":
      return guard(() => activeWorkers(ctx));
    default:
      return null;
  }
}

export const opsModule: ToolModule = { tools, handle };
