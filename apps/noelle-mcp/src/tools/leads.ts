import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { NoelleError, type NoelleContext } from "../context.js";
import type { ToolModule, ToolResult } from "../types.js";
import { guard, mdFields, mdTable, text, truncate } from "../result.js";
import {
  CONFIRM_PROP,
  LIMIT_PROP,
  ORG_PROP,
  limitOf,
  optBool,
  optNum,
  optStr,
  reqStr,
} from "./_shared.js";
import { getReplyRequestStatus, requestReply } from "./reply-requests.js";

// Leads = rows in noelle.leads: source posts discovered per org/agent. This
// module lists/inspects them and offers a few targeted mutations (flag as
// priority, request a DM, delete). Deleting a lead cascades its drafts and
// approvals via FK ON DELETE CASCADE.

const tools: Tool[] = [
  {
    name: "noelle_list_leads",
    description:
      "List discovered source posts (leads) for an org: platform, status, author, tier, classifier score, priority flag, and a text snippet. Filter by platform, status, priority, author handle, or recency (sinceHours).",
    inputSchema: {
      type: "object",
      properties: {
        org: ORG_PROP,
        platform: { type: "string", description: "Filter by platform (x, linkedin, reddit)." },
        status: {
          type: "string",
          description: "Filter by lead status (e.g. new, drafted, skipped).",
        },
        priority: { type: "boolean", description: "Filter by the watchlist/priority flag." },
        handle: { type: "string", description: "Filter by author handle (case-insensitive)." },
        sinceHours: { type: "number", description: "Only leads created within the last N hours." },
        limit: LIMIT_PROP,
      },
    },
  },
  {
    name: "noelle_get_lead",
    description:
      "Get one lead's full detail — author, platform, status, tier, classifier score, external id, and source text — plus every draft/approval angle generated from it.",
    inputSchema: {
      type: "object",
      properties: { org: ORG_PROP, leadId: { type: "string", description: "Lead uuid." } },
      required: ["leadId"],
    },
  },
  {
    name: "noelle_flag_lead",
    description:
      "Flag (or unflag) a lead as priority/watchlist. Priority leads sort to the top of the queue and can bypass some filters. Defaults to priority=true.",
    inputSchema: {
      type: "object",
      properties: {
        org: ORG_PROP,
        leadId: { type: "string", description: "Lead uuid." },
        priority: {
          type: "boolean",
          description: "true to flag as priority (default), false to clear.",
        },
      },
      required: ["leadId"],
    },
  },
  {
    name: "noelle_request_dm",
    description:
      "Mark a lead as DM-requested (sets payload.dm_requested=true) so the DM auto-draft lane will draft an outreach DM for it.",
    inputSchema: {
      type: "object",
      properties: { org: ORG_PROP, leadId: { type: "string", description: "Lead uuid." } },
      required: ["leadId"],
    },
  },
  {
    name: "noelle_request_reply",
    description:
      "Queue a one-off human-review reply draft for an existing X or LinkedIn lead. This does not enable recurring reply lanes or send anything. Repeat the same requestKey to read the same request; pass a new requestKey to ask for another regeneration.",
    annotations: {
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
      readOnlyHint: false,
    },
    inputSchema: {
      type: "object",
      properties: {
        org: ORG_PROP,
        leadId: { type: "string", description: "Lead uuid." },
        platform: {
          type: "string",
          enum: ["x", "linkedin"],
          description: "Optional platform guard.",
        },
        requestKey: {
          type: "string",
          maxLength: 200,
          description: "Stable idempotency key. Default: lead id.",
        },
        instructions: {
          type: "string",
          description: "Optional guidance for this requested draft.",
        },
        waitSeconds: {
          type: "number",
          description: "Optionally poll up to 45 seconds for a completed draft.",
        },
      },
      required: ["leadId"],
    },
  },
  {
    name: "noelle_get_reply_request_status",
    description:
      "Read the current status and completed draft bodies for a one-off reply request on an X or LinkedIn lead.",
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: {
      type: "object",
      properties: {
        org: ORG_PROP,
        leadId: { type: "string", description: "Lead uuid." },
        requestKey: {
          type: "string",
          maxLength: 200,
          description: "Request key to display. Default: current stored request.",
        },
        waitSeconds: {
          type: "number",
          description: "Optionally poll up to 45 seconds for a completed draft or review result.",
        },
      },
      required: ["leadId"],
    },
  },
  {
    name: "noelle_delete_lead",
    description:
      "Permanently delete a lead. Cascade-deletes its drafts and approvals. Irreversible — requires confirm:true.",
    inputSchema: {
      type: "object",
      properties: {
        org: ORG_PROP,
        leadId: { type: "string", description: "Lead uuid." },
        confirm: CONFIRM_PROP,
      },
      required: ["leadId"],
    },
  },
];

async function listLeads(args: Record<string, unknown>, ctx: NoelleContext): Promise<ToolResult> {
  const org = await ctx.resolveOrg(optStr(args, "org"));
  const platform = optStr(args, "platform");
  const status = optStr(args, "status");
  const priorityArg = optBool(args, "priority");
  const handle = optStr(args, "handle");
  const sinceHours = optNum(args, "sinceHours");
  const limit = limitOf(args);

  const rows = await ctx.sql<
    Array<{
      id: string;
      external_id: string | null;
      platform: string | null;
      status: string | null;
      author_handle: string | null;
      tier: string | null;
      classifier_label: string | null;
      classifier_score: string | null;
      priority: boolean | null;
      created_at: string;
      lead_text: string | null;
    }>
  >`
    select id, external_id, platform, status, author_handle, tier, classifier_label, classifier_score,
      priority, created_at::text as created_at, l.payload->>'text' as lead_text
    from noelle.leads l
    where org_id = ${org.orgId}
      and (${platform ?? null}::text is null or platform = ${platform ?? null})
      and (${status ?? null}::text is null or status = ${status ?? null})
      and (${priorityArg ?? null}::boolean is null or priority = ${priorityArg ?? null})
      and (${handle ?? null}::text is null or lower(author_handle) = lower(${handle ?? null}))
      and (${sinceHours ?? null}::int is null or created_at >= now() - (${sinceHours ?? null}::int || ' hours')::interval)
    order by created_at desc
    limit ${limit}`;

  const table = mdTable(
    ["id", "author", "platform", "status", "tier", "score", "priority", "snippet"],
    rows.map((r) => [
      r.id,
