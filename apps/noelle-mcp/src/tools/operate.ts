import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { NoelleError, type NoelleContext } from "../context.js";
import type { ToolModule, ToolResult } from "../types.js";
import { guard, mdFields, mdTable, text, truncate } from "../result.js";
import {
  AGENT_SELECTOR_PROPS,
  LIMIT_PROP,
  ORG_PROP,
  limitOf,
  optStr,
  reqStr,
  resolveAgentInstance,
} from "./_shared.js";

// Structured operator tools for the highest-value gaps that raw SQL (admin.ts)
// can do but shouldn't have to: writing an agent's safety/tuning knobs, putting
// a stuck lead back in the queue, editing a generated post draft, and searching
// free text. Each is org-scoped and column-whitelisted so a chat operator gets
// an ergonomic, hard-to-footgun path for the things they'll do most.

// Agent-config columns a chat operator may set, grouped by coercion. These are
// exactly the knobs noelle_get_agent DISPLAYS but nothing could WRITE — most
// importantly the autosend surface and the budget cap. Booleans accept
// true/false; integers must be non-negative whole numbers. Everything else on
// agent_instances stays out of reach (use noelle_sql_execute for the long tail).
const BOOL_COLS = new Set([
  "auto_send_enabled",
  "send_enabled",
  "reply_send_enabled",
  "discovery_enabled",
  "classifier_enabled",
  "drafter_enabled",
  "profiler_enabled",
  "watchlist_enabled",
  "dm_autodraft_enabled",
  "linkedin_intro_dm_enabled",
  "auto_defer_dms",
  "x_api_write_enabled",
  "escalate_on_cap",
  "pause_on_5xx",
  "notify_low_confidence",
]);
const INT_COLS = new Set([
  "auto_send_min_delay_sec",
  "auto_send_max_delay_sec",
  "auto_send_max_per_hour",
  "classifier_threshold",
  "budget_cap_cents",
  "budget_alert_pct",
  "pending_drafts_cap",
  "lead_backlog_cap",
  "goal_target",
  "x_api_daily_write_cap",
]);
const TEXT_COLS = new Set(["objective"]);
const ALL_COLS = [...BOOL_COLS, ...INT_COLS, ...TEXT_COLS].sort();

const tools: Tool[] = [
  {
    name: "noelle_set_agent_config",
    description:
      "Set an agent's safety/tuning knobs — the ones noelle_get_agent shows but no other tool can change. Pass `config` as an object of column→value. Booleans: auto_send_enabled, send_enabled, reply_send_enabled, discovery_enabled, classifier_enabled, drafter_enabled, profiler_enabled, watchlist_enabled, dm_autodraft_enabled, linkedin_intro_dm_enabled, auto_defer_dms, x_api_write_enabled, escalate_on_cap, pause_on_5xx, notify_low_confidence. Integers: auto_send_min_delay_sec, auto_send_max_delay_sec, auto_send_max_per_hour, classifier_threshold, budget_cap_cents, budget_alert_pct, pending_drafts_cap, lead_backlog_cap, goal_target, x_api_daily_write_cap. Text: objective. Select the agent by role or agentInstanceId (or omit both if the org has one agent). Send semantics: reply_send_enabled is the MASTER send gate (false ⇒ nothing posts at all); auto_send_enabled is autopilot (the actuator drains without a human click). Actual posting is done by the browser actuator extension, so neither flag sends anything on its own — and reply_send_enabled=false + auto_send_enabled=true looks 'armed' while silently blocking every send.",
    inputSchema: {
      type: "object",
      properties: {
        org: ORG_PROP,
        ...AGENT_SELECTOR_PROPS,
        config: {
          type: "object",
          description: "Object of column→value to set (see the tool description for allowed columns and types).",
        },
      },
      required: ["config"],
    },
  },
  {
    name: "noelle_requeue_lead",
    description:
      "Put a lead back into the pipeline by resetting its status (default 'new'), so the classifier/drafter re-processes it on the next tick. The recovery path for errored or stranded leads. For a whole batch (e.g. every 'errored' lead), use noelle_sql_execute instead.",
    inputSchema: {
      type: "object",
      properties: {
        org: ORG_PROP,
        leadId: { type: "string", description: "Lead uuid." },
        status: { type: "string", description: "Target status to set (default 'new'; e.g. new, classified)." },
      },
      required: ["leadId"],
    },
  },
  {
    name: "noelle_edit_post_draft",
    description:
      "Edit a generated post draft's body in place (saved as final_body) while it is still status='draft', without publishing it. The Posts-lane analogue of noelle_edit_draft. Follow with noelle_mark_post_ready to move it to ready.",
    inputSchema: {
      type: "object",
      properties: {
        org: ORG_PROP,
        draftId: { type: "string", description: "post_drafts uuid (from noelle_list_post_drafts / noelle_get_post)." },
        body: { type: "string", description: "The new draft body." },
      },
      required: ["draftId", "body"],
    },
  },
  {
    name: "noelle_search",
    description:
      "Full-text (case-insensitive substring) search across the org's leads, CRM persons, post ideas, post drafts, and reply/DM drafts. Use this to find 'the thread about X' or an author when you don't have an id.",
    inputSchema: {
      type: "object",
      properties: {
        org: ORG_PROP,
        query: { type: "string", description: "Text to search for (matched as a substring, case-insensitive)." },
        limit: LIMIT_PROP,
      },
      required: ["query"],
    },
  },
];

async function setAgentConfig(args: Record<string, unknown>, ctx: NoelleContext): Promise<ToolResult> {
  ctx.assertWritable("set agent config");
  const org = await ctx.resolveOrg(optStr(args, "org"));
  const agent = await resolveAgentInstance(ctx, org.orgId, args);

  const config = args.config;
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    throw new NoelleError("`config` must be an object of column→value.");
  }
  const patch: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(config as Record<string, unknown>)) {
    if (BOOL_COLS.has(key)) {
      if (typeof value === "boolean") patch[key] = value;
      else if (value === "true") patch[key] = true;
      else if (value === "false") patch[key] = false;
      else throw new NoelleError(`${key} must be a boolean (got ${JSON.stringify(value)}).`);
    } else if (INT_COLS.has(key)) {
      const n = typeof value === "number" ? value : Number(value);
      if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) {
        throw new NoelleError(`${key} must be a non-negative integer (got ${JSON.stringify(value)}).`);
      }
      patch[key] = n;
    } else if (TEXT_COLS.has(key)) {
      if (typeof value !== "string") throw new NoelleError(`${key} must be a string.`);
      patch[key] = value;
    } else {
      throw new NoelleError(
        `Unknown or non-settable agent column "${key}". Settable columns: ${ALL_COLS.join(", ")}. For anything else use noelle_sql_execute.`,
      );
    }
  }
  const keys = Object.keys(patch);
  if (keys.length === 0) throw new NoelleError("`config` had no settable columns.");

  const rows = await ctx.sql<Array<{ id: string }>>`
    update noelle.agent_instances set ${ctx.sql(patch, ...keys)}, updated_at = now()
    where id = ${agent.id} and org_id = ${org.orgId} returning id`;
  if (rows.length === 0) throw new NoelleError(`Agent ${agent.id} not found in ${org.name}.`);

  return text(
    `Updated **${agent.display_name ?? agent.role}** (${agent.role}) config:\n\n${mdFields(patch)}`,
  );
}

async function requeueLead(args: Record<string, unknown>, ctx: NoelleContext): Promise<ToolResult> {
  ctx.assertWritable("re-queue a lead");
  const org = await ctx.resolveOrg(optStr(args, "org"));
  const leadId = reqStr(args, "leadId");
  const status = optStr(args, "status") ?? "new";
  const rows = await ctx.sql<Array<{ id: string; status: string }>>`
    update noelle.leads set status = ${status}, updated_at = now()
    where id = ${leadId} and org_id = ${org.orgId} returning id, status`;
  if (rows.length === 0) throw new NoelleError(`Lead ${leadId} not found in ${org.name}.`);
  return text(
    `Lead \`${leadId}\` re-queued (status=${status}); the pipeline will re-process it on its next tick.`,
  );
}

async function editPostDraft(args: Record<string, unknown>, ctx: NoelleContext): Promise<ToolResult> {
  ctx.assertWritable("edit a post draft");
  const org = await ctx.resolveOrg(optStr(args, "org"));
  const draftId = reqStr(args, "draftId");
  const body = reqStr(args, "body");
  const rows = await ctx.sql<Array<{ id: string }>>`
    update noelle.post_drafts set final_body = ${body}, updated_at = now()
    where id = ${draftId} and org_id = ${org.orgId} and status = 'draft' returning id`;
  if (rows.length === 0) {
    throw new NoelleError(`Post draft ${draftId} not found or not in 'draft' status in ${org.name}.`);
  }
  return text(
    `Edited post draft \`${draftId}\` (saved as final_body). Use noelle_mark_post_ready to move it to ready.`,
  );
}

async function search(args: Record<string, unknown>, ctx: NoelleContext): Promise<ToolResult> {
  const org = await ctx.resolveOrg(optStr(args, "org"));
  const q = reqStr(args, "query");
  const like = `%${q}%`;
  const per = limitOf(args, 20, 100);
  const orgId = org.orgId;

