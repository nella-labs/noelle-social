import type { Sql } from "postgres";

export interface ActiveInstance {
  id: string;
  org_id: string;
  /** Lifecycle status ('active' | 'paused'). Orion's only lane is the subreddit
   *  watchlist, so pausing puts the whole pipeline to sleep — discovery /
   *  classifier / drafter act only on active instances (see
   *  listActiveRedditInternInstances). Optional so fixtures can omit it (absence
   *  reads as active). */
  status?: string;
  /**
   * Per-agent routing override set via the dashboard config page. Shape mirrors
   * `Partial<ModelRouting>`. Optional on the type so test fixtures don't have to
   * construct it. Production rows always have a value (null or a JSON object).
   */
  model_overrides?: unknown;
  /** Policy columns from 0010_agent_policies.sql. */
  budget_alert_pct?: number;
  escalate_on_cap?: boolean;
  pause_on_5xx?: boolean;
  notify_low_confidence?: boolean;
  /**
   * Backpressure caps from 0012_pending_drafts_cap.sql and
   * 0013_lead_backlog_cap.sql. NULL = no cap.
   */
  pending_drafts_cap?: number | null;
  lead_backlog_cap?: number | null;
  /** Operator mission from 0017_agent_objective.sql. NULL = base prompt. */
  objective?: string | null;
  /**
   * Operator-set classifier q-score threshold (0-100) from
   * 0042_classifier_threshold.sql. Overrides REDDIT_Q_THRESHOLD when set;
   * NULL = use the env default. Lower = looser filter (more posts drafted).
   */
  classifier_threshold?: number | null;
  /** Operator brand config from 0025_agent_brand_config.sql (jsonb). */
  brand_config?: unknown;
  /**
   * Per-worker enable flags from 0019_worker_enabled.sql. The instance status
   * (active/paused) is the master switch; within an active instance these let
   * the operator run each worker independently. Absence means enabled.
   *
   * Orion runs discovery → classifier → drafter. There is no send worker — Orion
   * never posts to Reddit — so send_enabled is irrelevant here and intentionally
   * not consulted.
   */
  discovery_enabled?: boolean;
  classifier_enabled?: boolean;
  drafter_enabled?: boolean;
  /**
   * Watchlist-lane flag from 0034_watchlist_enabled.sql. Orion is
   * subreddit-watchlist-only — every lead is a watched-subreddit post — so this is
   * the sub-switch for the discovery lane within an ACTIVE instance: turning it off
   * stops discovery from sweeping subreddits without pausing the instance. It does
   * NOT keep Orion working while paused (pausing sleeps the whole pipeline; see
   * status). Absence means enabled. See isWorkerEnabled.
   */
  watchlist_enabled?: boolean;
  /** Goal-run + pipeline-session state from 0021_pipeline_goal.sql. */
  pipeline_started_at?: string | null;
  goal_target?: number | null;
  goal_started_at?: string | null;
  /**
   * Tailored-discovery config from 0032_discovery_config.sql (jsonb). The saved
   * DEFAULT (discovery_config) + the active per-run OVERRIDE (run_config), both
   * Partial<DiscoveryConfig>. Orion honours the Reddit-applicable subset (window
   * + posts-per-subreddit); see resolveRedditDiscovery.
   */
  discovery_config?: unknown;
  run_config?: unknown;
}

export type RedditInternWorkerKind =
  | "discovery"
  | "classifier"
  | "drafter"
  | "watchlist";

/**
 * Whether a specific worker is enabled for an instance. Default-on: only an
 * explicit `false` disables it, so a row/fixture missing the flag keeps the
 * "all workers run" behaviour.
 */
export function isWorkerEnabled(inst: ActiveInstance, kind: RedditInternWorkerKind): boolean {
  const flag = inst[`${kind}_enabled` as const];
  return flag !== false;
}

// Single source of truth for the worker-facing instance row. Both selectors
// pull the same columns; they differ only in the status filter.
async function listRedditInternInstancesByStatus(
  sql: Sql,
  statuses: readonly string[],
): Promise<ActiveInstance[]> {
  const rows = await sql<ActiveInstance[]>`
    select
      id,
      org_id,
      status,
      model_overrides,
      budget_alert_pct,
      escalate_on_cap,
      pause_on_5xx,
      notify_low_confidence,
      pending_drafts_cap,
      lead_backlog_cap,
      objective,
      classifier_threshold,
      brand_config,
      discovery_enabled,
      classifier_enabled,
      drafter_enabled,
      watchlist_enabled,
      pipeline_started_at,
      goal_target,
      goal_started_at,
      discovery_config,
      run_config
    from noelle.agent_instances
    where role = 'reddit_intern'
      and status = any(${statuses as string[]})
  `;
  return [...rows];
}

// "Should the pipeline workers do work?" — discovery / classifier / drafter all
// act only on rows returned here. Orion's only lane is the subreddit watchlist
// (not priority people, unlike Vega/Lyra), so there is no reason to keep working
// while paused: pausing the instance puts the whole pipeline to sleep, and a
// paused row simply isn't returned. Status flips on the dashboard Start/Pause
// button propagate within one poll cycle.
export async function listActiveRedditInternInstances(
  sql: Sql,
): Promise<ActiveInstance[]> {
  return listRedditInternInstancesByStatus(sql, ["active"]);
}
