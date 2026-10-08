import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { NoelleError, type NoelleContext } from "../context.js";
import type { ToolModule, ToolResult } from "../types.js";
import { guard, mdTable, text } from "../result.js";
import { CONFIRM_PROP, ORG_PROP, optBool, optStr, reqBool, reqStr } from "./_shared.js";

// Connections = rows in noelle.connections: the data-source credentials an org's
// workers use (e.g. Apify API tokens). Health is derived from the
// invalid/exhausted/retry timestamps. The `secret` column is write-only here —
// it is never selected or printed back.

const tools: Tool[] = [
  {
    name: "noelle_list_connections",
    description:
      "List the org's data-source connections (e.g. Apify API tokens): id, kind, label, active, in_use, and derived health (live / exhausted / invalid). The stored secret is never shown. Defaults to kind 'apify'; pass kind='all' to list every kind.",
    inputSchema: {
      type: "object",
      properties: {
        org: ORG_PROP,
        kind: {
          type: "string",
          description:
            "Connection kind to filter by (e.g. 'apify'). Pass 'all' for every kind. Defaults to 'apify'.",
        },
      },
    },
  },
  {
    name: "noelle_add_connection",
    description:
      "Add a data-source connection for the org (e.g. an Apify API token). The secret is stored write-only and is never printed back.",
    inputSchema: {
      type: "object",
      properties: {
        org: ORG_PROP,
        kind: { type: "string", description: "Connection kind, e.g. 'apify'." },
        label: { type: "string", description: "Human label to identify this connection." },
        secret: {
          type: "string",
          description: "The API token / secret to store. Never printed back.",
        },
      },
      required: ["kind", "label", "secret"],
    },
  },
  {
    name: "noelle_set_connection_active",
    description: "Enable or disable a connection by setting its active flag.",
    inputSchema: {
      type: "object",
      properties: {
        org: ORG_PROP,
        connectionId: { type: "string", description: "Connection uuid." },
        active: { type: "boolean", description: "true to enable, false to disable." },
      },
      required: ["connectionId", "active"],
    },
  },
  {
    name: "noelle_delete_connection",
    description: "Permanently delete a connection. Requires confirm:true.",
    inputSchema: {
      type: "object",
      properties: {
        org: ORG_PROP,
        connectionId: { type: "string", description: "Connection uuid." },
        confirm: CONFIRM_PROP,
      },
      required: ["connectionId"],
    },
  },
];

async function listConnections(
  args: Record<string, unknown>,
  ctx: NoelleContext,
): Promise<ToolResult> {
  const org = await ctx.resolveOrg(optStr(args, "org"));
  const kindArg = optStr(args, "kind") ?? "apify";
  const kindFilter = kindArg === "all" ? null : kindArg;

  const rows = await ctx.sql<
    Array<{
      id: string;
      kind: string;
      label: string | null;
      active: boolean;
      in_use: boolean | null;
      created_at: string;
      health: string;
    }>
  >`
    select id, kind, label, active, in_use, created_at::text as created_at,
      case when invalid_at is not null then 'invalid'
           when exhausted_at is not null and (retry_at is null or retry_at > now()) then 'exhausted'
           else 'live' end as health
    from noelle.connections
    where org_id = ${org.orgId} and (${kindFilter}::text is null or kind = ${kindFilter})
    order by kind asc, created_at asc`;

  const table = mdTable(
    ["id", "kind", "label", "active", "in_use", "health"],
    rows.map((r) => [r.id, r.kind, r.label ?? "—", r.active, r.in_use ?? false, r.health]),
  );
  return text(`**${org.name}** — ${rows.length} connection(s)\n\n${table}`);
}

async function addConnection(
  args: Record<string, unknown>,
  ctx: NoelleContext,
): Promise<ToolResult> {
  ctx.assertWritable("add a connection");
  const org = await ctx.resolveOrg(optStr(args, "org"));
  const kind = reqStr(args, "kind");
  const label = reqStr(args, "label");
  const secret = reqStr(args, "secret");

  const rows = await ctx.sql<Array<{ id: string }>>`
    insert into noelle.connections (org_id, kind, label, secret, active)
    values (${org.orgId}, ${kind}, ${label}, ${secret}, true)
    returning id`;
  return text(`Added **${kind}** connection "${label}" in ${org.name}. id=${rows[0]!.id}`);
}

async function setConnectionActive(
  args: Record<string, unknown>,
  ctx: NoelleContext,
): Promise<ToolResult> {
  ctx.assertWritable("change a connection's active state");
  const org = await ctx.resolveOrg(optStr(args, "org"));
  const connectionId = reqStr(args, "connectionId");
  const active = reqBool(args, "active");

  const rows = await ctx.sql<Array<{ id: string }>>`
    update noelle.connections set active = ${active}, updated_at = now()
    where id = ${connectionId} and org_id = ${org.orgId}
    returning id`;
  if (rows.length === 0) throw new NoelleError(`Connection ${connectionId} not found in this org.`);
  return text(`Connection ${connectionId} is now **${active ? "active" : "inactive"}**.`);
}

async function deleteConnection(
  args: Record<string, unknown>,
  ctx: NoelleContext,
): Promise<ToolResult> {
  ctx.assertWritable("delete a connection");
  const org = await ctx.resolveOrg(optStr(args, "org"));
  const connectionId = reqStr(args, "connectionId");
  const confirm = optBool(args, "confirm") ?? false;
  if (!confirm) {
    return text(
      `Refusing to delete without confirm:true. This will permanently delete connection ${connectionId}. Re-run with confirm:true to proceed.`,
    );
  }
  const rows = await ctx.sql<Array<{ id: string }>>`
    delete from noelle.connections where id = ${connectionId} and org_id = ${org.orgId}
    returning id`;
  if (rows.length === 0) throw new NoelleError(`Connection ${connectionId} not found in this org.`);
  return text(`Deleted connection ${connectionId} from ${org.name}.`);
}

async function handle(
  name: string,
  args: Record<string, unknown>,
  ctx: NoelleContext,
): Promise<ToolResult | null> {
  switch (name) {
    case "noelle_list_connections":
      return guard(() => listConnections(args, ctx));
    case "noelle_add_connection":
      return guard(() => addConnection(args, ctx));
    case "noelle_set_connection_active":
      return guard(() => setConnectionActive(args, ctx));
    case "noelle_delete_connection":
      return guard(() => deleteConnection(args, ctx));
    default:
      return null;
  }
}

export const connectionsModule: ToolModule = { tools, handle };
