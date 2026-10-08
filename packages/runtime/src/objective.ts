/**
 * Resolve an agent instance's effective objective (mission).
 *
 * An agent's objective lives in two places by design:
 *   - `agent_instances.objective` — the operator's mission, NULL until edited
 *     (0017_agent_objective.sql).
 *   - the agent type's manifest `short_description` — the built-in default.
 *
 * This is the single collapse point used everywhere the objective is read:
 * the dashboard (display), the x_intern workers (classifier + drafter prompt
 * steering), and the chat context. Reading `instance.objective` raw would show
 * a blank objective for every never-edited instance; always resolve instead.
 *
 * Pure + dependency-free so it can run in the worker, the route, and the
 * dashboard bundle alike.
 *
 * @param objective the raw `agent_instances.objective` value (may be null,
 *                   undefined, empty, or whitespace-only)
 * @param fallback  the manifest default (`short_description`)
 * @returns the trimmed operator objective when set, else the trimmed fallback
 */
export function resolveObjective(
  objective: string | null | undefined,
  fallback: string,
): string {
  const trimmed = objective?.trim();
  if (trimmed) return trimmed;
  return fallback.trim();
}

/** True when the instance carries an operator-set objective (vs. manifest default). */
export function hasCustomObjective(objective: string | null | undefined): boolean {
  return !!objective && objective.trim().length > 0;
}
