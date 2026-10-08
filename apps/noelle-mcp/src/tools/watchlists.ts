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
  const kind = reqStr(args, "kind");
  const value = reqStr(args, "value");
  assertCombo(platform, kind);
  const objective = optStr(args, "objective") ?? null;
  const objectiveKind = optStr(args, "objectiveKind") ?? null;
  const minScore = optNum(args, "minScore") ?? 0;

  if (platform === "x" && (kind === "handle" || kind === "keyword")) {
    const v = kind === "handle" ? normHandle(value) : value.trim();
    await ctx.sql`
      insert into noelle.x_watchlist (org_id, agent_instance_id, kind, value)
      values (${org.orgId}, ${agent.id}, ${kind}, ${v})
      on conflict (agent_instance_id, kind, value) do nothing`;
    return text(
      `Watching X ${kind} **${kind === "handle" ? "@" + v : v}** for ${agent.display_name ?? agent.role}.`,
    );
  }

  if (platform === "x" && kind === "person") {
    const h = normHandle(value);
    await ctx.sql`
      insert into noelle.x_watchlist_people (org_id, agent_instance_id, handle, objective_kind, objective_note)
      values (${org.orgId}, ${agent.id}, ${h}, ${objectiveKind}, ${objective})
      on conflict (agent_instance_id, handle)
      do update set objective_kind = excluded.objective_kind, objective_note = excluded.objective_note`;
    return text(`Watching X person **@${h}** for ${agent.display_name ?? agent.role}.`);
  }

  if (platform === "linkedin") {
    await ctx.sql`
      insert into noelle.linkedin_watchlist (org_id, agent_instance_id, kind, value)
      values (${org.orgId}, ${agent.id}, 'keyword', ${value.trim()})
      on conflict (agent_instance_id, kind, value) do nothing`;
    return text(
      `Watching LinkedIn keyword **${value.trim()}** for ${agent.display_name ?? agent.role}.`,
    );
  }

  // reddit subreddit — update-then-insert (no ON CONFLICT in the app)
  const sub = normSub(value);
  const updated = await ctx.sql<Array<{ id: string }>>`
    update noelle.reddit_watchlist set objective = ${objective}, min_score = ${minScore}
    where agent_instance_id = ${agent.id} and org_id = ${org.orgId} and subreddit = ${sub}
    returning id`;
  if (updated.length === 0) {
    await ctx.sql`
      insert into noelle.reddit_watchlist (org_id, agent_instance_id, subreddit, objective, min_score)
      values (${org.orgId}, ${agent.id}, ${sub}, ${objective}, ${minScore})`;
  }
  return text(`Watching subreddit **r/${sub}** for ${agent.display_name ?? agent.role}.`);
}

async function removeWatchlistEntry(
  args: Record<string, unknown>,
  ctx: NoelleContext,
): Promise<ToolResult> {
  ctx.assertWritable("remove a watchlist entry");
  const org = await ctx.resolveOrg(optStr(args, "org"));
  const agent = await resolveAgentInstance(ctx, org.orgId, args);
  const platform = reqStr(args, "platform");
  const kind = reqStr(args, "kind");
  const rowId = reqStr(args, "rowId");
  assertCombo(platform, kind);

  const table =
    platform === "x" && kind === "person"
      ? "x_watchlist_people"
      : platform === "x"
        ? "x_watchlist"
        : platform === "linkedin"
          ? "linkedin_watchlist"
          : "reddit_watchlist";

  const rows = await ctx.sql<Array<{ id: string }>>`
    delete from noelle.${ctx.sql(table)}
    where id = ${rowId} and org_id = ${org.orgId} and agent_instance_id = ${agent.id}
    returning id`;
  if (rows.length === 0) throw new NoelleError(`No ${table} row ${rowId} for this agent.`);
  return text(`Removed watchlist entry ${rowId}.`);
}

async function handle(
  name: string,
  args: Record<string, unknown>,
  ctx: NoelleContext,
): Promise<ToolResult | null> {
  switch (name) {
    case "noelle_list_watchlist":
      return guard(() => listWatchlist(args, ctx));
    case "noelle_add_watchlist_entry":
      return guard(() => addWatchlistEntry(args, ctx));
    case "noelle_remove_watchlist_entry":
      return guard(() => removeWatchlistEntry(args, ctx));
    default:
      return null;
  }
}

export const watchlistsModule: ToolModule = { tools, handle };
