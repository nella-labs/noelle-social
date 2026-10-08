import type { Sql } from "postgres";
import { resolveLaneConfig } from "@noelle/contracts";

export interface ActiveInstance {
  id: string;
  org_id: string;
  /**
   * The agent role that owns this instance ('linkedin_intern' | 'x_intern').
   * Only selected by the cross-role post-pipeline selector
   * (listActiveOrPausedPostPipelineInstances); undefined on the LinkedIn-only
   * selectors, where every row is a linkedin_intern by construction. The
   * post-drafter reads it to draft X-owned ideas (Vega) alongside LinkedIn ones.
   */
  role?: string;
  /** Lifecycle status ('active' | 'paused'). The drafter runs the reply lane
   *  only while active; paused instances tick solely for on-demand DM requests.
   *  Optional so fixtures can omit it (absence reads as active). */
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
   * 0042_classifier_threshold.sql. Overrides LINKEDIN_Q_THRESHOLD when set;
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
   * Lyra runs discovery → classifier → drafter (+ profiler). There is no send
   * worker — Lyra never posts to LinkedIn — so send_enabled is irrelevant here
   * and intentionally not consulted.
   */
  discovery_enabled?: boolean;
  classifier_enabled?: boolean;
  drafter_enabled?: boolean;
  /** Answer people who replied to us. Runs while PAUSED, like watchlist. */
  notifications_enabled?: boolean;
  /**
   * Profiler enable flag from 0024_profiler_enabled.sql. The profiler is
   * decoupled from the master Start/Pause — its selector returns paused
   * instances too — so this flag is its only switch.
   */
  profiler_enabled?: boolean;
  /**
   * Always-on watchlist-lane flag from 0034_watchlist_enabled.sql. Lyra is
   * watchlist-only — every lead is a watched-connection post — so this is the
   * master "keep working while paused" switch: discovery → classifier → drafter
   * keep replying to watched connections even when the instance is paused (e.g.
   * after a goal stalls + auto-pauses), as long as this is on. Absence means
   * enabled. See isWorkerEnabled.
   */
  watchlist_enabled?: boolean;
  /**
   * Auto-DM enable flag from 0036_dm_autodraft_enabled.sql. When false (the
   * default) Lyra drafts replies only; the cold-outreach DM is auto-drafted
   * alongside the reply only when this is true. Absence = off (opt-in).
   */
  dm_autodraft_enabled?: boolean;
  /**
   * Intro-DM lane enable flag from 0039_linkedin_intro_dm_enabled.sql. When true,
   * the drafter drafts one warm relationship intro DM per profiled connection
   * (never during a goal-run). Absence = fall back to LINKEDIN_INTRO_DM_ENABLED
   * (legacy env, for a worker running before the migration applied).
   */
  linkedin_intro_dm_enabled?: boolean;
  /** Goal-run + pipeline-session state from 0021_pipeline_goal.sql. */
  pipeline_started_at?: string | null;
  goal_target?: number | null;
  goal_started_at?: string | null;
  /**
   * Tailored-discovery config from 0032_discovery_config.sql (jsonb). The saved
   * DEFAULT (discovery_config) + the active per-run OVERRIDE (run_config), both
   * Partial<DiscoveryConfig>. Lyra honours the LinkedIn-applicable subset (window
   * + posts-per-connection + reaction/comment floors); see resolveLinkedinDiscovery.
   */
  discovery_config?: unknown;
  run_config?: unknown;
  /**
   * Profile-first discovery ICP (0043_linkedin_icp_config.sql, jsonb). Validated
   * by IcpConfigSchema at use; NULL = profile-first discovery is OFF (Lyra runs
   * watchlist + keyword lanes exactly as before).
   */
  icp_config?: unknown;
  /**
   * Per-lane enable state (0049_agent_instances_lane_config.sql, jsonb). The
   * Posts lane gates ideation + post-drafter on lane_config.posts.enabled.
   * Empty/absent → legacy (Posts off). Replies/DMs still gate via their existing
   * *_enabled columns; lane_config carries the Posts lane only at the worker level.
   */
  lane_config?: unknown;
  /**
   * Account Feeder config (0051_account_feeder.sql, jsonb). Validated by
   * AccountFeederConfigSchema (@noelle/contracts) at use; the drafter reads the
   * selection knobs (maxStyleExemplars / varietyTemperature / minPerformance
   * Percentile) when NOELLE_DRAFTER_STYLE is on. NULL = no override (schema
   * defaults). The feeder's RUN flags live on separate columns the feeder worker
   * reads (see account-feeder-db.ts) — this is just the consumer-side config.
   */
  account_feeder_config?: unknown;
}

/** Whether the Posts lane is enabled for this instance (lane_config, 0049). */
export function isPostsLaneEnabled(inst: ActiveInstance): boolean {
  return resolveLaneConfig(inst.lane_config).posts.enabled;
}

export type LinkedinInternWorkerKind =
  | "discovery"
  | "classifier"
  | "profiler"
  | "drafter"
  | "watchlist"
  | "notifications";

/**
 * Whether a specific worker is enabled for an instance. Default-on: only an
 * explicit `false` disables it, so a row/fixture missing the flag keeps the
 * "all workers run" behaviour.
 */
export function isWorkerEnabled(inst: ActiveInstance, kind: LinkedinInternWorkerKind): boolean {
  const flag = inst[`${kind}_enabled` as const];
  return flag !== false;
}

// Single source of truth for the worker-facing instance row. Both selectors
// pull the same columns; they differ only in the status filter.
async function listLinkedinInternInstancesByStatus(
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
      notifications_enabled,
      profiler_enabled,
      watchlist_enabled,
      dm_autodraft_enabled,
      linkedin_intro_dm_enabled,
      pipeline_started_at,
      goal_target,
      goal_started_at,
      discovery_config,
      run_config,
      icp_config,
      lane_config,
      account_feeder_config
    from noelle.agent_instances
    where role = 'linkedin_intern'
      and status = any(${statuses as string[]})
  `;
  return [...rows];
}

// "Should the pipeline workers do work?" — discovery/drafter only act on rows
// returned here. Status flips on the dashboard Start/Pause button propagate
// within one poll cycle.
export async function listActiveLinkedinInternInstances(
  sql: Sql,
): Promise<ActiveInstance[]> {
  return listLinkedinInternInstancesByStatus(sql, ["active"]);
}

// Discovery / classifier / drafter use this so the always-on WATCHLIST lane keeps
// Lyra replying to watched connections for PAUSED instances too — not just active
// ones. Each worker gates on (active OR watchlist_enabled): active runs the full
// funnel under the goal + backpressure caps; paused runs the watchlist lane only
// when watchlist_enabled (the goal auto-pause no longer applies, but the inbox
// backpressure caps still do). The on-demand DM pass also runs while paused.
// See 0034_watchlist_enabled.sql.
export async function listActiveOrPausedLinkedinInternInstances(
  sql: Sql,
): Promise<ActiveInstance[]> {
  return listLinkedinInternInstancesByStatus(sql, ["active", "paused"]);
}

// The profiler is decoupled from Start/Pause (0024): watchlist profiling is
// passive enrichment, useful while the pipeline is paused. So it sees active
// AND paused instances and gates only on profiler_enabled in its onTick.
export async function listProfilerLinkedinInternInstances(
  sql: Sql,
): Promise<ActiveInstance[]> {
  return listLinkedinInternInstancesByStatus(sql, ["active", "paused"]);
}

// The POST pipeline (ideation + post-drafter) spans both content interns: ideas
// are owned by either the LinkedIn intern (Lyra) or the X intern (Vega). The
// post-drafter runs in this process for BOTH so an X-owned approved idea is
// drafted too — it already drafts platform='x' variants of LinkedIn-owned ideas
// (the cross-platform fan-out), so the only thing missing was claiming X-owned
// rows. Selects `role` so the worker attributes spend + picks routing per intern.
// agent_instances is one shared table, so the LinkedIn-specific columns are
// present (null/default) on x_intern rows — selecting them is harmless.
export async function listActiveOrPausedPostPipelineInstances(
  sql: Sql,
): Promise<ActiveInstance[]> {
  const rows = await sql<ActiveInstance[]>`
    select
      id,
      org_id,
      role,
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
      notifications_enabled,
      profiler_enabled,
      watchlist_enabled,
      dm_autodraft_enabled,
      linkedin_intro_dm_enabled,
      pipeline_started_at,
      goal_target,
      goal_started_at,
      discovery_config,
      run_config,
      icp_config,
      lane_config,
      account_feeder_config
    from noelle.agent_instances
    where role in ('linkedin_intern', 'x_intern')
      and status = any(${["active", "paused"] as string[]})
  `;
  return [...rows];
}
