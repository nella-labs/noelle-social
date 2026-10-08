/**
 * Agent-detail URL helpers.
 *
 * Agents are addressed in the URL by a human slug derived from their display
 * name (e.g. "Vega" → `/app/{org}/agents/vega`) instead of the raw instance
 * UUID. The slug is purely a URL nicety: every route still accepts the UUID
 * (so old links and bookmarks keep working), and all data access / server
 * actions use the resolved `instance.id`, never the slug.
 *
 * Pure + client-safe (no DB import) so link generators in client components
 * and the server route resolvers share one slug definition.
 */

export const AGENT_UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * URL slug for an agent. Slugifies the display name; falls back to the UUID
 * when the name is empty (so the link still resolves). For every hired agent
 * the display name is set, so this yields stable names like `vega`.
 */
export function agentSlug(
  name: string | null | undefined,
  fallbackId: string,
): string {
  const base = (name ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return base || fallbackId;
}

/** Canonical agent-detail href (optionally a sub-page like `config`). */
export function agentHref(
  orgSlug: string,
  agent: { name?: string | null; display_name?: string | null; id: string; instanceId?: string | null },
  sub?: string,
): string {
  const id = agent.instanceId ?? agent.id;
  const slug = agentSlug(agent.display_name ?? agent.name, id);
  return `/app/${orgSlug}/agents/${slug}${sub ? `/${sub}` : ""}`;
}

/**
 * Find the single instance a slug param refers to, matching on the slugified
 * display name. Returns null when nothing matches or the slug is ambiguous
 * (two agents slugging to the same name) — callers then fall back to a 404.
 */
export function matchAgentBySlug<
  T extends { display_name: string | null; id: string },
>(instances: T[], param: string): T | null {
  const matches = instances.filter(
    (i) => agentSlug(i.display_name, i.id) === param,
  );
  return matches.length === 1 ? matches[0] : null;
}
