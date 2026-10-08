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
  const [a] = await ctx.sql<Array<Record<string, unknown>>>`
    select id, role, display_name, status, objective, budget_cap_cents, budget_alert_pct,
      discovery_enabled, classifier_enabled, drafter_enabled, send_enabled, profiler_enabled,
      watchlist_enabled, dm_autodraft_enabled, linkedin_intro_dm_enabled, auto_defer_dms, reply_send_enabled,
      coalesce(lane_config #> '{dms,relationship_dms_enabled}' = 'true'::jsonb, false) as friendly_dms_enabled,
      auto_send_enabled, auto_send_min_delay_sec, auto_send_max_delay_sec, auto_send_max_per_hour,
      pending_drafts_cap, lead_backlog_cap, classifier_threshold, x_api_write_enabled,
      x_api_daily_write_cap, goal_target, pipeline_started_at::text as pipeline_started_at,
      created_at::text as created_at
    from noelle.agent_instances where id = ${sel.id} and org_id = ${org.orgId} limit 1`;
  if (!a) throw new NoelleError(`Agent ${sel.id} not found.`);

  const [spend] = await ctx.sql<Array<{ cents: number }>>`
    select coalesce(sum(cents), 0)::int as cents from noelle.llm_calls
    where org_id = ${org.orgId} and agent_role = ${sel.role} and engine <> 'apify'
      and started_at >= date_trunc('month', now())`;

  const lines: string[] = [
    `## ${a.display_name ?? sel.role}  (\`${sel.role}\`)`,
    `- **id:** ${a.id}`,
    `- **status:** ${a.status}`,
  ];
  if (a.objective) lines.push(`- **objective:** ${a.objective}`);
  lines.push(
    `- **lanes:** discovery=${a.discovery_enabled} classifier=${a.classifier_enabled} drafter=${a.drafter_enabled} send=${a.send_enabled} profiler=${a.profiler_enabled} watchlist=${a.watchlist_enabled} dm_autodraft=${a.dm_autodraft_enabled}`,
    `- **Friendly DMs:** enabled=${a.friendly_dms_enabled} (independent of the reply pipeline)`,
    `- **reply sending:** enabled=${a.reply_send_enabled}`,
    `- **auto-send:** enabled=${a.auto_send_enabled} delay=${a.auto_send_min_delay_sec}-${a.auto_send_max_delay_sec}s max/hr=${a.auto_send_max_per_hour}`,
    `- **caps:** budget=${a.budget_cap_cents != null ? `$${(Number(a.budget_cap_cents) / 100).toFixed(0)}` : "—"} pending_drafts=${a.pending_drafts_cap ?? "—"} lead_backlog=${a.lead_backlog_cap ?? "—"}`,
    `- **X API write:** enabled=${a.x_api_write_enabled} daily_cap=${a.x_api_daily_write_cap}`,
    `- **spend this month:** $${((spend?.cents ?? 0) / 100).toFixed(2)}`,
  );
  return text(lines.join("\n"));
}

async function hireAgent(args: Record<string, unknown>, ctx: NoelleContext): Promise<ToolResult> {
  ctx.assertWritable("hire an agent");
  const org = await ctx.resolveOrg(optStr(args, "org"));
  const role = reqStr(args, "role");
  const preset = HIRE_PRESETS[role];
  if (!preset)
    throw new NoelleError(
      `Unknown role "${role}". Supported: ${Object.keys(HIRE_PRESETS).join(", ")}.`,
    );
  const displayName = optStr(args, "displayName") ?? preset.display_name;

  const rows = await ctx.sql<Array<{ id: string }>>`
    insert into noelle.agent_instances
      (org_id, role, status, display_name, budget_cap_cents, classifier_enabled, send_enabled, auto_send_enabled)
    values (${org.orgId}, ${role}, 'active', ${displayName}, 5000, ${preset.classifier}, ${preset.send}, ${preset.auto_send})
    on conflict (org_id, role) do nothing
    returning id`;

  if (rows.length === 0)
    return text(`Agent role **${role}** already exists in ${org.name}. No change.`);
  return text(`Hired **${displayName}** (\`${role}\`) in ${org.name}. id=${rows[0]!.id}`);
}

async function setAgentStatus(
  args: Record<string, unknown>,
  ctx: NoelleContext,
): Promise<ToolResult> {
  ctx.assertWritable("change agent status");
  const org = await ctx.resolveOrg(optStr(args, "org"));
  const sel = await resolveAgentInstance(ctx, org.orgId, args);
  const status = reqStr(args, "status");
  if (status !== "active" && status !== "paused")
    throw new NoelleError(`status must be "active" or "paused".`);
  const rows = await ctx.sql<Array<{ id: string }>>`
    update noelle.agent_instances set status = ${status}, updated_at = now()
    where id = ${sel.id} and org_id = ${org.orgId} and status in ('active', 'paused')
    returning id`;
  if (rows.length === 0)
    throw new NoelleError(`Could not update ${sel.role} (not active/paused?).`);
  return text(`${sel.display_name ?? sel.role} (\`${sel.role}\`) is now **${status}**.`);
}

async function setWorkerEnabled(
  args: Record<string, unknown>,
  ctx: NoelleContext,
): Promise<ToolResult> {
  ctx.assertWritable("toggle a worker lane");
  const org = await ctx.resolveOrg(optStr(args, "org"));
  const sel = await resolveAgentInstance(ctx, org.orgId, args);
  const worker = reqStr(args, "worker");
  const column = WORKER_COLUMN[worker];
  if (!column) throw new NoelleError(`Unknown worker "${worker}".`);
  const enabled = reqBool(args, "enabled");
  const rows = await ctx.sql<Array<{ id: string }>>`
    update noelle.agent_instances set ${ctx.sql(column)} = ${enabled}, updated_at = now()
    where id = ${sel.id} and org_id = ${org.orgId}
    returning id`;
  if (rows.length === 0) throw new NoelleError(`Could not update ${sel.role}.`);
  return text(
    `${sel.display_name ?? sel.role}: **${worker}** lane is now ${enabled ? "enabled" : "disabled"}.`,
  );
}

async function setActuatorState(
  args: Record<string, unknown>,
  ctx: NoelleContext,
): Promise<ToolResult> {
  ctx.assertWritable("start/stop the actuator");
  const org = await ctx.resolveOrg(optStr(args, "org"));
  const sel = await resolveAgentInstance(ctx, org.orgId, args);
  const desired = reqStr(args, "desired");
  if (desired !== "running" && desired !== "stopped")
    throw new NoelleError(`desired must be "running" or "stopped".`);
  const rows = await ctx.sql<Array<{ id: string }>>`
    update noelle.agent_instances
    set actuator_desired_state = ${desired}, actuator_command_at = now(), updated_at = now()
    where id = ${sel.id} and org_id = ${org.orgId}
    returning id`;
  if (rows.length === 0) throw new NoelleError(`Could not update ${sel.role}.`);
  const verb = desired === "running" ? "**start** (Full-automatic)" : "**stop**";
  const note =
    desired === "running"
      ? " — the hands are now allowed to run (replies still only post when reply-sending is on)."
      : " — any live run ends and the hands stay paused until you start again.";
  return text(`${sel.display_name ?? sel.role}'s actuator is set to ${verb}${note}`);
}

async function startAll(args: Record<string, unknown>, ctx: NoelleContext): Promise<ToolResult> {
  ctx.assertWritable("start all agents");
  const org = await ctx.resolveOrg(optStr(args, "org"));
  const goal = optNum(args, "goalTarget") ?? null;
  const rows = await ctx.sql<Array<{ id: string }>>`
    update noelle.agent_instances set
      status = 'active', discovery_enabled = true, classifier_enabled = true, drafter_enabled = true,
      pipeline_started_at = now(), goal_target = ${goal},
      goal_started_at = case when ${goal}::int is null then goal_started_at else now() end,
      last_goal_started_at = case when ${goal}::int is null then last_goal_started_at else now() end,
      updated_at = now()
    where org_id = ${org.orgId} and status in ('active', 'paused')
      and role = any(${[...SOCIAL_AGENT_ROLES]}::text[])
    returning id`;
  return text(
    `Started **${rows.length}** agent(s) in ${org.name}${goal ? ` toward a goal of ${goal} leads` : ""}.`,
  );
}

async function stopAll(args: Record<string, unknown>, ctx: NoelleContext): Promise<ToolResult> {
  ctx.assertWritable("stop all agents");
  const org = await ctx.resolveOrg(optStr(args, "org"));
  const rows = await ctx.sql<Array<{ id: string }>>`
    update noelle.agent_instances set
      status = 'paused', goal_target = null, goal_started_at = null, run_config = null, updated_at = now()
    where org_id = ${org.orgId} and status in ('active', 'paused')
      and role = any(${[...SOCIAL_AGENT_ROLES]}::text[])
    returning id`;
  return text(`Paused **${rows.length}** agent(s) in ${org.name}.`);
}

async function handle(
  name: string,
  args: Record<string, unknown>,
  ctx: NoelleContext,
): Promise<ToolResult | null> {
  switch (name) {
    case "noelle_list_agents":
      return guard(() => listAgents(args, ctx));
    case "noelle_get_agent":
      return guard(() => getAgent(args, ctx));
    case "noelle_hire_agent":
      return guard(() => hireAgent(args, ctx));
    case "noelle_set_agent_status":
      return guard(() => setAgentStatus(args, ctx));
    case "noelle_set_worker_enabled":
      return guard(() => setWorkerEnabled(args, ctx));
    case "noelle_set_actuator_state":
      return guard(() => setActuatorState(args, ctx));
    case "noelle_start_all_agents":
      return guard(() => startAll(args, ctx));
    case "noelle_stop_all_agents":
      return guard(() => stopAll(args, ctx));
    default:
      return null;
  }
}

export const agentsModule: ToolModule = { tools, handle };
