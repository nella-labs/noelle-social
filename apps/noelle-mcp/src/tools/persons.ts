import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { NoelleError, type NoelleContext } from "../context.js";
import type { ToolModule, ToolResult } from "../types.js";
import { guard, mdTable, text } from "../result.js";
import { CONFIRM_PROP, LIMIT_PROP, ORG_PROP, limitOf, optBool, optStr, reqStr } from "./_shared.js";

// A lightweight CRM over noelle.persons + noelle.person_social_accounts. A
// person can own many social accounts (x/linkedin/reddit), each with a handle
// and/or url. Deleting a person cascades its social accounts. Mirrors the
// structure of orgs.ts/agents.ts exactly.

// A single social account as returned by the json_agg column.
type Account = { platform: string; handle: string | null; url: string | null };

// The three platforms allowed by the row CHECK on person_social_accounts.
const PLATFORMS = ["x", "linkedin", "reddit"] as const;
type Platform = (typeof PLATFORMS)[number];

function assertPlatform(platform: string): asserts platform is Platform {
  if (!PLATFORMS.includes(platform as Platform)) {
    throw new NoelleError(
      `Invalid platform "${platform}". Must be one of: ${PLATFORMS.join(", ")}.`,
    );
  }
}

// Render one account as "x:@handle" or "linkedin:url" for compact list views.
function fmtAccount(a: Account): string {
  const ref = a.handle ? `@${a.handle}` : (a.url ?? "");
  return `${a.platform}:${ref}`;
}

const tools: Tool[] = [
  {
    name: "noelle_list_persons",
    description:
      "List the org's tracked persons (CRM) alphabetically, each with their linked social accounts (x/linkedin/reddit handles or urls).",
    inputSchema: { type: "object", properties: { org: ORG_PROP, limit: LIMIT_PROP } },
  },
  {
    name: "noelle_get_person",
    description:
      "Get one person's full detail: display name, notes, and every linked social account.",
    inputSchema: {
      type: "object",
      properties: { org: ORG_PROP, personId: { type: "string", description: "Person uuid." } },
      required: ["personId"],
    },
  },
  {
    name: "noelle_add_person",
    description:
      "Add a person to the CRM. Optionally attach one social account in the same call by passing platform plus a handle and/or url.",
    inputSchema: {
      type: "object",
      properties: {
        org: ORG_PROP,
        displayName: { type: "string", description: "The person's display name." },
        notes: { type: "string", description: "Freeform notes about this person." },
        platform: {
          type: "string",
          enum: [...PLATFORMS],
          description: "Optional: platform for an initial social account.",
        },
        handle: { type: "string", description: "Optional: social handle (without leading @)." },
        url: { type: "string", description: "Optional: profile url." },
      },
      required: ["displayName"],
    },
  },
  {
    name: "noelle_update_person",
    description:
      "Update a person's display name and/or notes. Only the fields you pass change; omit a field to leave it as-is.",
    inputSchema: {
      type: "object",
      properties: {
        org: ORG_PROP,
        personId: { type: "string", description: "Person uuid." },
        displayName: { type: "string", description: "New display name." },
        notes: { type: "string", description: "New notes." },
      },
      required: ["personId"],
    },
  },
  {
    name: "noelle_delete_person",
    description:
      "Delete a person and cascade-delete all of their social accounts. Requires confirm:true.",
    inputSchema: {
      type: "object",
      properties: {
        org: ORG_PROP,
        personId: { type: "string", description: "Person uuid." },
        confirm: CONFIRM_PROP,
      },
      required: ["personId"],
    },
  },
  {
    name: "noelle_add_social_account",
    description:
      "Attach a social account (x/linkedin/reddit) to a person. Needs a handle or a url. If a matching handle already exists on that platform, it's re-linked to this person instead of duplicated.",
    inputSchema: {
      type: "object",
      properties: {
        org: ORG_PROP,
        personId: { type: "string", description: "Person uuid to attach the account to." },
        platform: {
          type: "string",
          enum: [...PLATFORMS],
          description: "Social platform.",
        },
        handle: { type: "string", description: "Social handle (without leading @)." },
        url: { type: "string", description: "Profile url." },
      },
      required: ["personId", "platform"],
    },
  },
  {
    name: "noelle_remove_social_account",
    description:
      "Remove a single social account by its account id. Not cascade-dangerous, so confirm is optional.",
    inputSchema: {
      type: "object",
      properties: {
        org: ORG_PROP,
        accountId: { type: "string", description: "Social account uuid to delete." },
        confirm: CONFIRM_PROP,
      },
      required: ["accountId"],
    },
  },
];

async function listPersons(args: Record<string, unknown>, ctx: NoelleContext): Promise<ToolResult> {
  const org = await ctx.resolveOrg(optStr(args, "org"));
  const limit = limitOf(args);
  const rows = await ctx.sql<Array<{ id: string; display_name: string; accounts: Account[] }>>`
    select p.id, p.display_name,
      coalesce(json_agg(json_build_object('platform', a.platform, 'handle', a.handle, 'url', a.url)
        order by a.platform) filter (where a.id is not null), '[]') as accounts
    from noelle.persons p
    left join noelle.person_social_accounts a on a.person_id = p.id
    where p.org_id = ${org.orgId}
    group by p.id, p.display_name
    order by p.display_name asc
    limit ${limit}`;

  const table = mdTable(
    ["id", "display_name", "handles"],
    rows.map((r) => [r.id, r.display_name, r.accounts.map(fmtAccount).join(", ") || "—"]),
  );
  return text(`**${org.name}** — ${rows.length} person(s)\n\n${table}`);
}

async function getPerson(args: Record<string, unknown>, ctx: NoelleContext): Promise<ToolResult> {
  const org = await ctx.resolveOrg(optStr(args, "org"));
  const personId = reqStr(args, "personId");
  const rows = await ctx.sql<
    Array<{ id: string; display_name: string; notes: string | null; accounts: Account[] }>
  >`
    select p.id, p.display_name, p.notes,
      coalesce(json_agg(json_build_object('platform', a.platform, 'handle', a.handle, 'url', a.url)
        order by a.platform) filter (where a.id is not null), '[]') as accounts
    from noelle.persons p
    left join noelle.person_social_accounts a on a.person_id = p.id
    where p.id = ${personId} and p.org_id = ${org.orgId}
    group by p.id, p.display_name, p.notes`;

  const person = rows[0];
  if (!person) throw new NoelleError(`Person ${personId} not found in ${org.name}.`);

  const lines: string[] = [`## ${person.display_name}`, `- **id:** ${person.id}`];
  if (person.notes) lines.push(`- **notes:** ${person.notes}`);
  const accTable = mdTable(
    ["platform", "handle", "url"],
    person.accounts.map((a) => [a.platform, a.handle ? `@${a.handle}` : "—", a.url ?? "—"]),
  );
  lines.push("", `### Social accounts (${person.accounts.length})`, accTable);
  return text(lines.join("\n"));
}

async function addPerson(args: Record<string, unknown>, ctx: NoelleContext): Promise<ToolResult> {
  ctx.assertWritable("add a person");
  const org = await ctx.resolveOrg(optStr(args, "org"));
  const displayName = reqStr(args, "displayName");
  const notes = optStr(args, "notes");
  const platform = args["platform"] === undefined ? undefined : reqStr(args, "platform");
  const handle = optStr(args, "handle");
  const url = optStr(args, "url");
  if (platform) {
    assertPlatform(platform);
    if (!handle && !url)
      throw new NoelleError("A social account needs a handle or a url (or both).");
  } else if (handle || url) {
    throw new NoelleError("An initial social account needs a platform.");
  }

  const personId = await ctx.sql.begin(async (tx) => {
