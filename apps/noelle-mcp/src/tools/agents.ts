import { SOCIAL_AGENT_ROLES } from "@noelle/runtime/types";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { NoelleError, type NoelleContext } from "../context.js";
import type { ToolModule, ToolResult } from "../types.js";
import { guard, mdTable, text } from "../result.js";
import {
  AGENT_SELECTOR_PROPS,
  ORG_PROP,
  optNum,
  optStr,
  reqBool,
  reqStr,
  resolveAgentInstance,
} from "./_shared.js";

// Agents = rows in noelle.agent_instances (one per role per org). All policy
// knobs are columns on that row. Mutations mirror the app's server actions in
// apps/app/src/app/app/[orgSlug]/agents/[instanceId]/actions.ts.

// worker name → agent_instances boolean column (matches setWorkerEnabled).
const WORKER_COLUMN: Record<string, string> = {
  discovery: "discovery_enabled",
  classifier: "classifier_enabled",
  drafter: "drafter_enabled",
  send: "send_enabled",
  profiler: "profiler_enabled",
  watchlist: "watchlist_enabled",
  dm_autodraft: "dm_autodraft_enabled",
};

// Sensible defaults for a freshly hired agent, mirroring hireAgent presets.
const HIRE_PRESETS: Record<
  string,
  { display_name: string; classifier: boolean; send: boolean; auto_send: boolean }
> = {
  x_intern: { display_name: "Vega", classifier: true, send: true, auto_send: false },
  linkedin_intern: { display_name: "Lyra", classifier: false, send: false, auto_send: false },
  reddit_intern: { display_name: "Orion", classifier: true, send: false, auto_send: false },
  video_intern: { display_name: "Nova", classifier: true, send: false, auto_send: false },
};

const tools: Tool[] = [
  {
    name: "noelle_list_agents",
    description:
      "List the org's agents (agent_instances): role, display name, status (active/paused), enabled lanes, budget cap, and spend this month.",
    inputSchema: { type: "object", properties: { org: ORG_PROP } },
  },
  {
    name: "noelle_get_agent",
    description:
      "Get one agent's full detail: status, objective, every enabled lane, auto-send config, caps, budget, and month-to-date spend. Select by role or agentInstanceId.",
    inputSchema: {
      type: "object",
      properties: { org: ORG_PROP, ...AGENT_SELECTOR_PROPS },
    },
  },
  {
    name: "noelle_hire_agent",
    description:
      "Create an agent for a role that doesn't have one yet (x_intern, linkedin_intern, reddit_intern, video_intern). Idempotent: no-op if the role already exists. Inserts with that role's default persona and lane presets.",
    inputSchema: {
      type: "object",
      properties: {
        org: ORG_PROP,
        role: {
          type: "string",
          description: "Agent role to hire.",
          enum: ["x_intern", "linkedin_intern", "reddit_intern", "video_intern"],
        },
        displayName: { type: "string", description: "Override the default persona name." },
      },
      required: ["role"],
    },
  },
  {
    name: "noelle_set_agent_status",
    description: "Set an agent's reply pipeline to active or paused. Independent Friendly DMs and explicit creation requests can still run while paused.",
    inputSchema: {
      type: "object",
      properties: {
        org: ORG_PROP,
        ...AGENT_SELECTOR_PROPS,
        status: { type: "string", enum: ["active", "paused"], description: "New status." },
      },
      required: ["status"],
    },
  },
  {
    name: "noelle_set_worker_enabled",
    description:
      "Enable or disable a single pipeline lane on an agent: discovery, classifier, drafter, send, profiler, watchlist, or dm_autodraft.",
    inputSchema: {
      type: "object",
      properties: {
        org: ORG_PROP,
        ...AGENT_SELECTOR_PROPS,
        worker: {
          type: "string",
          enum: [
            "discovery",
            "classifier",
            "drafter",
            "send",
            "profiler",
            "watchlist",
            "dm_autodraft",
          ],
          description: "Which lane to toggle.",
        },
        enabled: { type: "boolean", description: "true to enable, false to disable." },
      },
      required: ["worker", "enabled"],
    },
  },
  {
    name: "noelle_set_actuator_state",
    description:
      "Remotely start or stop the browser actuator (the 'hands': Vega/X, Lyra/LinkedIn, Orion/Reddit). 'running' = run persistently (Full-automatic); 'stopped' = fully pause (ends any live run + gates autonomy off). The extension reconciles within ~1s. NOTE: 'running' means the hands are allowed to run, NOT send-consent — on X, replies still only post when reply-sending is on.",
    inputSchema: {
      type: "object",
      properties: {
        org: ORG_PROP,
        ...AGENT_SELECTOR_PROPS,
        desired: { type: "string", enum: ["running", "stopped"], description: "Remote actuator state." },
      },
      required: ["desired"],
    },
  },
  {
    name: "noelle_start_all_agents",
    description:
      "Start every agent in the org: set status=active and turn on discovery+classifier+drafter, stamping pipeline_started_at. Optionally set a goal_target (leads to process).",
    inputSchema: {
      type: "object",
      properties: {
        org: ORG_PROP,
        goalTarget: { type: "number", description: "Optional lead goal to run toward." },
      },
    },
  },
  {
    name: "noelle_stop_all_agents",
    description: "Pause every agent in the org and clear any running goal.",
    inputSchema: { type: "object", properties: { org: ORG_PROP } },
  },
];

async function listAgents(args: Record<string, unknown>, ctx: NoelleContext): Promise<ToolResult> {
  const org = await ctx.resolveOrg(optStr(args, "org"));
  const rows = await ctx.sql<
    Array<{
      role: string;
      display_name: string | null;
      status: string;
      discovery_enabled: boolean;
      classifier_enabled: boolean;
      drafter_enabled: boolean;
      send_enabled: boolean;
      budget_cap_cents: number | null;
      spend_cents: number;
    }>
  >`
    select a.role, a.display_name, a.status,
      a.discovery_enabled, a.classifier_enabled, a.drafter_enabled, a.send_enabled, a.budget_cap_cents,
      (select coalesce(sum(cents), 0)::int from noelle.llm_calls c
        where c.org_id = a.org_id and c.agent_role = a.role and c.engine <> 'apify'
          and c.started_at >= date_trunc('month', now())) as spend_cents
    from noelle.agent_instances a
    where a.org_id = ${org.orgId}
      and a.role = any(${[...SOCIAL_AGENT_ROLES]}::text[]) and a.status <> 'retired'
    order by a.role asc`;

  const lanes = (r: (typeof rows)[number]) =>
    [
      r.discovery_enabled ? "disc" : null,
      r.classifier_enabled ? "class" : null,
      r.drafter_enabled ? "draft" : null,
      r.send_enabled ? "send" : null,
    ]
      .filter(Boolean)
      .join("+") || "—";

  const table = mdTable(
    ["role", "name", "status", "lanes", "budget", "spend(mo)"],
    rows.map((r) => [
      r.role,
      r.display_name ?? "—",
      r.status,
      lanes(r),
      r.budget_cap_cents != null ? `$${(r.budget_cap_cents / 100).toFixed(0)}` : "—",
      `$${(r.spend_cents / 100).toFixed(2)}`,
    ]),
  );
  return text(`**${org.name}** — ${rows.length} agent(s)\n\n${table}`);
}

async function getAgent(args: Record<string, unknown>, ctx: NoelleContext): Promise<ToolResult> {
  const org = await ctx.resolveOrg(optStr(args, "org"));
  const sel = await resolveAgentInstance(ctx, org.orgId, args);
