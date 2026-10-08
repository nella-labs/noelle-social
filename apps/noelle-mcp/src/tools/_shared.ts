import { SOCIAL_AGENT_ROLES, isSocialAgentRole } from "@noelle/runtime/types";
import { NoelleError, type NoelleContext } from "../context.js";

// ── JSON Schema fragments reused across tools ──────────────────────────────
// The low-level SDK wants hand-written JSON Schema (no zod), so these are plain
// objects mixed into each tool's inputSchema.properties.

export const ORG_PROP = {
  type: "string",
  description: "Org slug or id. Defaults to NOELLE_MCP_ORG when omitted.",
} as const;

export const AGENT_SELECTOR_PROPS = {
  role: {
    type: "string",
    enum: [...SOCIAL_AGENT_ROLES],
    description:
      "Agent role to target (e.g. x_intern, linkedin_intern, reddit_intern). Use this OR agentInstanceId. If the org has exactly one agent, both may be omitted.",
  },
  agentInstanceId: {
    type: "string",
    description: "Agent instance uuid to target. Use this OR role.",
  },
} as const;

export const CONFIRM_PROP = {
  type: "boolean",
  description: "Must be true to actually perform this irreversible delete.",
} as const;

export const LIMIT_PROP = {
  type: "number",
  description: "Max rows to return (default 50).",
} as const;

// ── Argument coercion helpers ──────────────────────────────────────────────

export function optStr(args: Record<string, unknown>, key: string): string | undefined {
  const v = args[key];
  return typeof v === "string" && v.trim().length > 0 ? v.trim() : undefined;
}

export function reqStr(args: Record<string, unknown>, key: string): string {
  const v = optStr(args, key);
  if (v === undefined) throw new NoelleError(`Missing required argument: ${key}`);
  return v;
}

export function optNum(args: Record<string, unknown>, key: string): number | undefined {
  const v = args[key];
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return undefined;
}

export function optBool(args: Record<string, unknown>, key: string): boolean | undefined {
  const v = args[key];
  if (typeof v === "boolean") return v;
  if (v === "true") return true;
  if (v === "false") return false;
  return undefined;
}

export function reqBool(args: Record<string, unknown>, key: string): boolean {
  const v = optBool(args, key);
  if (v === undefined) throw new NoelleError(`Missing required boolean argument: ${key}`);
  return v;
}

export function optStrArray(args: Record<string, unknown>, key: string): string[] | undefined {
  const v = args[key];
  if (Array.isArray(v))
    return v
      .filter((x): x is string => typeof x === "string" && x.trim() !== "")
      .map((s) => s.trim());
  const s = optStr(args, key);
  return s ? [s] : undefined;
}

export function limitOf(args: Record<string, unknown>, def = 50, max = 500): number {
  const n = optNum(args, "limit");
  if (n === undefined) return def;
  return Math.max(1, Math.min(max, Math.floor(n)));
}

// First-of-month ISO date ("YYYY-MM-01"), the key shape used by org_spend_month.
export function currentMonthIso(d = new Date()): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  return `${y}-${m}-01`;
}

// ── Spend / budget-cap helpers ─────────────────────────────────────────────
// Apify (data-fetch actors) and X-API write buckets are recorded in
// org_spend_month for VISIBILITY only — they are EXEMPT from budget caps. The
// cap reader (packages/runtime/src/pgBudgetAdapters.ts) exempts those engines —
// apify in every intern, xapi in the X intern (the only app that writes xapi
// rows, and the only one passing CAP_EXEMPT_ENGINES_APIFY_XAPI). So infra cost
// can never trip a limit. Agents should never see infra cost counted against the cap, so every
// agent-facing spend total below excludes it. Buckets are named
// `apify-<worker>` / `xapi-<worker>`.
export const CAP_EXEMPT_BUCKET_PREFIXES = ["apify", "xapi"] as const;

export function isCapExemptBucket(bucket: string | null | undefined): boolean {
  return typeof bucket === "string" && CAP_EXEMPT_BUCKET_PREFIXES.some((p) => bucket.startsWith(p));
}

/** Total cap-relevant (LLM) spend from per-bucket rows — infra excluded. */
export function capRelevantCents(
  rows: Array<{ bucket?: string | null; cents?: number | string | null }>,
): number {
  let cents = 0;
  for (const r of rows) if (!isCapExemptBucket(r.bucket)) cents += Number(r.cents ?? 0);
  return cents;
}

/** Total infra (Apify + X-API) spend from per-bucket rows — never capped. */
export function infraCents(
  rows: Array<{ bucket?: string | null; cents?: number | string | null }>,
): number {
  let cents = 0;
  for (const r of rows) if (isCapExemptBucket(r.bucket)) cents += Number(r.cents ?? 0);
  return cents;
}

// ── Agent-instance resolution ──────────────────────────────────────────────
// Many tables (watchlists, post_ideas, post_drafts) are keyed on agent_instance_id.
// Resolve it from an explicit id, a role, or (if unambiguous) the org's only agent.
export async function resolveAgentInstance(
  ctx: NoelleContext,
  orgId: string,
  args: Record<string, unknown>,
): Promise<{ id: string; role: string; display_name: string | null }> {
  const instanceId = optStr(args, "agentInstanceId") ?? optStr(args, "instanceId");
  if (instanceId) {
    const rows = await ctx.sql<Array<{ id: string; role: string; display_name: string | null }>>`
      select id, role, display_name from noelle.agent_instances
      where id = ${instanceId} and org_id = ${orgId}
        and role = any(${[...SOCIAL_AGENT_ROLES]}::text[]) and status <> 'retired' limit 1`;
    if (!rows[0]) throw new NoelleError(`No agent instance ${instanceId} in this org.`);
    return rows[0];
  }
  const role = optStr(args, "role") ?? optStr(args, "agentRole");
  if (role) {
    if (!isSocialAgentRole(role)) throw new NoelleError(`Unsupported social role "${role}".`);
    const rows = await ctx.sql<Array<{ id: string; role: string; display_name: string | null }>>`
      select id, role, display_name from noelle.agent_instances
      where org_id = ${orgId} and role = ${role} and status <> 'retired' limit 1`;
    if (!rows[0]) throw new NoelleError(`No agent with role "${role}" in this org.`);
    return rows[0];
  }
  const rows = await ctx.sql<Array<{ id: string; role: string; display_name: string | null }>>`
    select id, role, display_name from noelle.agent_instances where org_id = ${orgId}
      and role = any(${[...SOCIAL_AGENT_ROLES]}::text[]) and status <> 'retired' order by role asc`;
  if (rows.length === 1) return rows[0]!;
  if (rows.length === 0)
    throw new NoelleError("This org has no agents yet. Hire one with noelle_hire_agent.");
  throw new NoelleError(
    `Multiple agents in this org — pass role or agentInstanceId. Available roles: ${rows.map((r) => r.role).join(", ")}.`,
  );
}
