import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { NoelleError, type NoelleContext } from "../context.js";
import type { ToolModule, ToolResult } from "../types.js";
import { guard, mdTable, text } from "../result.js";
import {
  AGENT_SELECTOR_PROPS,
  ORG_PROP,
  optNum,
  optStr,
  reqStr,
  resolveAgentInstance,
} from "./_shared.js";

// Targeting: what each agent watches. Steers discovery. All rows are keyed on
// (agent_instance_id, org_id). Mirrors the app's watchlist server actions.
//   x_watchlist        — kind handle|keyword, value; unique (agent_instance_id,kind,value)
//   x_watchlist_people — handle + objective; unique (agent_instance_id,handle)
//   linkedin_watchlist — kind keyword only, value
//   reddit_watchlist   — subreddit, objective, min_score

const PLATFORM_KINDS: Record<string, string[]> = {
  x: ["handle", "keyword", "person"],
  linkedin: ["keyword"],
  reddit: ["subreddit"],
};

function normHandle(v: string): string {
  return v.replace(/^@+/, "").trim().toLowerCase();
}
function normSub(v: string): string {
  return v
    .replace(/^\/?r\//i, "")
    .replace(/^@+/, "")
    .trim()
    .toLowerCase();
}

function platformKinds(platform: string): string[] {
  const kinds = PLATFORM_KINDS[platform];
  if (!Object.hasOwn(PLATFORM_KINDS, platform) || !kinds)
    throw new NoelleError(`platform must be one of: ${Object.keys(PLATFORM_KINDS).join(", ")}.`);
  return kinds;
}

function assertCombo(platform: string, kind: string): void {
  const kinds = platformKinds(platform);
  if (!kinds.includes(kind))
    throw new NoelleError(`For platform "${platform}", kind must be one of: ${kinds.join(", ")}.`);
}

const tools: Tool[] = [
  {
    name: "noelle_list_watchlist",
    description:
      "List an agent's watchlist (targeting). platform=x shows watched handles, keywords, and people; linkedin shows keywords; reddit shows subreddits. Select the agent by role or agentInstanceId.",
    inputSchema: {
      type: "object",
      properties: {
        org: ORG_PROP,
        ...AGENT_SELECTOR_PROPS,
        platform: {
          type: "string",
          enum: Object.keys(PLATFORM_KINDS),
          description: "Which platform's watchlist.",
        },
      },
      required: ["platform"],
    },
  },
  {
    name: "noelle_add_watchlist_entry",
    description:
      "Add a targeting entry to steer discovery. x: kind handle|keyword|person (person adds a watched account with an optional objective). linkedin: kind keyword. reddit: kind subreddit (value=subreddit, optional objective/minScore). Idempotent on the natural key.",
    inputSchema: {
      type: "object",
      properties: {
        org: ORG_PROP,
        ...AGENT_SELECTOR_PROPS,
        platform: { type: "string", enum: ["x", "linkedin", "reddit"] },
        kind: {
          type: "string",
          enum: ["handle", "keyword", "person", "subreddit"],
          description: "Entry kind (must match the platform).",
        },
        value: { type: "string", description: "The handle, keyword, or subreddit to watch." },
        objective: {
          type: "string",
          description: "For person/subreddit: freeform objective note.",
        },
        objectiveKind: { type: "string", description: "For x person entries: objective category." },
        minScore: {
          type: "number",
          description: "For reddit: minimum post score to consider (default 0).",
        },
      },
      required: ["platform", "kind", "value"],
    },
  },
  {
    name: "noelle_remove_watchlist_entry",
    description:
      "Remove a watchlist entry by its row id. Pass the same platform and kind you listed it under so the right table is targeted.",
    inputSchema: {
      type: "object",
      properties: {
        org: ORG_PROP,
        ...AGENT_SELECTOR_PROPS,
        platform: { type: "string", enum: ["x", "linkedin", "reddit"] },
        kind: { type: "string", enum: ["handle", "keyword", "person", "subreddit"] },
        rowId: { type: "string", description: "The watchlist row id to delete." },
      },
      required: ["platform", "kind", "rowId"],
    },
  },
];

async function listWatchlist(
  args: Record<string, unknown>,
  ctx: NoelleContext,
): Promise<ToolResult> {
  const org = await ctx.resolveOrg(optStr(args, "org"));
  const agent = await resolveAgentInstance(ctx, org.orgId, args);
  const platform = reqStr(args, "platform");
  platformKinds(platform);

  if (platform === "x") {
    const entries = await ctx.sql<Array<{ id: string; kind: string; value: string }>>`
      select id, kind, value from noelle.x_watchlist
      where agent_instance_id = ${agent.id} and org_id = ${org.orgId} order by created_at asc`;
    const people = await ctx.sql<
      Array<{
        id: string;
        handle: string | null;
        objective_kind: string | null;
        objective_note: string | null;
      }>
    >`
      select id, handle, objective_kind, objective_note from noelle.x_watchlist_people
      where agent_instance_id = ${agent.id} and org_id = ${org.orgId} order by added_at asc`;
    const entriesTable = mdTable(
      ["id", "kind", "value"],
      entries.map((entry) => [
        entry.id,
        entry.kind,
        entry.kind === "handle" ? `@${entry.value}` : entry.value,
      ]),
    );
    const peopleTable = mdTable(
      ["id", "handle", "objective"],
      people.map((p) => [
        p.id,
        `@${p.handle ?? ""}`,
        [p.objective_kind, p.objective_note].filter(Boolean).join(": "),
      ]),
    );
    return text(
      [
        `## ${agent.display_name ?? agent.role} — X watchlist`,
        `**Handles and keywords (${entries.length}):**`,
        entriesTable,
        `**Watched people (${people.length}):**`,
        peopleTable,
      ].join("\n\n"),
    );
  }

  if (platform === "linkedin") {
    const rows = await ctx.sql<Array<{ id: string; kind: string; value: string }>>`
      select id, kind, value from noelle.linkedin_watchlist
      where agent_instance_id = ${agent.id} and org_id = ${org.orgId} order by created_at asc`;
    return text(
      `## ${agent.display_name ?? agent.role} — LinkedIn watchlist\n\n${mdTable(
        ["id", "kind", "value"],
        rows.map((r) => [r.id, r.kind, r.value]),
      )}`,
    );
  }

  // reddit
  const rows = await ctx.sql<
    Array<{ id: string; subreddit: string; objective: string | null; min_score: number }>
  >`
    select id, subreddit, objective, min_score from noelle.reddit_watchlist
    where agent_instance_id = ${agent.id} and org_id = ${org.orgId} order by added_at asc`;
  return text(
    `## ${agent.display_name ?? agent.role} — Reddit watchlist\n\n${mdTable(
      ["id", "subreddit", "objective", "min_score"],
      rows.map((r) => [r.id, `r/${r.subreddit}`, r.objective ?? "—", r.min_score]),
    )}`,
  );
}

async function addWatchlistEntry(
  args: Record<string, unknown>,
  ctx: NoelleContext,
): Promise<ToolResult> {
  ctx.assertWritable("add a watchlist entry");
  const org = await ctx.resolveOrg(optStr(args, "org"));
  const agent = await resolveAgentInstance(ctx, org.orgId, args);
  const platform = reqStr(args, "platform");
