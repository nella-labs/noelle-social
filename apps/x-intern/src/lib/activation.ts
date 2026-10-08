import type { Sql } from "postgres";

export interface ActiveInstance {
  id: string;
  org_id: string;
  /**
   * Instance lifecycle status ('active' | 'paused'). The keyword lane only runs
   * when 'active'; the always-on watchlist lane (and profiler/send) also run for
   * 'paused' instances, so workers that see both branch on this. Optional on the
   * type so fixtures can omit it (absence is treated as 'active').
   */
  status?: string;
  /**
   * Per-agent routing override set via the dashboard config page. Shape
   * mirrors `Partial<ModelRouting>` — `{primary?: EngineHandle, fallback?:
   * EngineHandle | null}`. Null fallback means "fail the run on primary
   * error". When the whole field is null/undefined, workers use the agent
   * type's documented default (see `xInternRouting()` in lib/routing.ts).
   *
   * Optional on the type so test fixtures don't have to construct the
   * override shape. Production rows always have a value (null or a JSON
   * object) since the column is non-null with default '{}' in the schema.
   */
  model_overrides?: unknown;
  /**
   * Policy columns from 0010_agent_policies.sql. Optional on the type
   * so test fixtures don't break; production rows always have values
   * (the columns are NOT NULL with defaults in the schema).
   */
  budget_alert_pct?: number;
  escalate_on_cap?: boolean;
  pause_on_5xx?: boolean;
  notify_low_confidence?: boolean;
  /**
   * Auto-send columns from 0015_auto_send.sql. Optional on the type so
   * test fixtures don't have to spell them out; production rows always
   * carry concrete values (NOT NULL with defaults in the migration).
   */
  auto_send_enabled?: boolean;
  auto_send_min_delay_sec?: number;
  auto_send_max_delay_sec?: number;
  auto_send_max_per_hour?: number;
  /**
   * Backpressure caps from 0012_pending_drafts_cap.sql and
   * 0013_lead_backlog_cap.sql. NULL = no cap (default). When a cap is
   * set, workers consult it at the top of `onTick` and skip when the
   * matching count is at or above the threshold:
   *
   *   - pending_drafts_cap: drafter+classifier+discovery all pause
   *     when pending approvals for this instance are at the cap.
   *   - lead_backlog_cap: discovery alone pauses when undrafted leads
   *     (status in new/classifying/classified/drafting) hit the cap.
   *     Classifier/drafter keep draining the existing backlog.
   *
   * See: apps/x-intern/src/workers/{drafter,classifier,discovery}.ts
   */
  pending_drafts_cap?: number | null;
  lead_backlog_cap?: number | null;
  /**
   * Operator mission from 0017_agent_objective.sql. NULL = no custom
   * objective (the drafter/classifier fall back to their base prompts).
   * When set, it steers the drafter angle/emphasis and the classifier's
   * relevance judgement. Optional on the type so test fixtures can omit it.
   */
  objective?: string | null;
  /**
   * Per-instance reply-worthiness bar (0-100), from mig 0042
   * agent_instances.classifier_threshold. Overrides X_Q_THRESHOLD when set.
   * Shared column: Lyra and Orion have read it since #184/#230; Vega ignored it,
   * so the dashboard's strictness control silently did nothing for the X intern.
   */
  classifier_threshold?: number | null;
  /**
   * ICP author gate (mig 0043 icp_config) — a SHARED column Vega has always had
   * and never read. When it carries headlineKeywords, the classifier drops
   * non-priority authors whose bio clearly does not match, before the LLM call.
   */
  icp_config?: unknown;
  /**
   * Operator brand config from 0025_agent_brand_config.sql (jsonb). Persona,
   * product/offer, pitch policy, reply + DM styles, and brand Q&A — composed
   * into the drafter system prompt via renderBrandBlock(). Raw jsonb; validated
   * against BrandConfigSchema at use. Optional on the type for fixtures; '{}'
   * (the column default) means "no brand config → generic peer behaviour".
   */
  brand_config?: unknown;
  /**
   * Per-worker enable flags from 0019_worker_enabled.sql. The instance status
   * (active/paused) is the master switch; within an active instance these let
   * the operator run each worker independently. Optional on the type so test
   * fixtures can omit them — absence means enabled (see isWorkerEnabled).
   * Production rows are NOT NULL with default true.
   */
  discovery_enabled?: boolean;
  classifier_enabled?: boolean;
  drafter_enabled?: boolean;
  /** Answer people who replied to us. Runs while PAUSED, like watchlist. */
  notifications_enabled?: boolean;
  send_enabled?: boolean;
  /**
   * Master "reply sending" switch (0081_reply_send_enabled.sql). OFF by default:
   * unlike the *_enabled flags above (which default on, absence = enabled), this
   * is fail-closed, so absence / not-true = sending disabled. Replies are still
   * drafted + queued; nothing posts until the operator turns it on. The send
   * worker gates its whole tick on it.
   */
  reply_send_enabled?: boolean;
  /**
   * Profiler enable flag from 0024_profiler_enabled.sql. Unlike the four flags
   * above, the profiler is decoupled from the master Start/Pause — it runs for
   * active *and* paused instances (see listProfilerXInternInstances) and gates
   * only on this flag, so profiling can run alone while the pipeline is paused.
   * Optional on the type so fixtures can omit it — absence means enabled.
   */
  profiler_enabled?: boolean;
  /**
   * Auto-DM enable flag from 0036_dm_autodraft_enabled.sql. When false (the
   * default) the drafter emits replies only; a cold-outreach DM is auto-drafted
   * alongside the reply only when this is true. Absence = off (opt-in).
   */
  dm_autodraft_enabled?: boolean;
  /**
   * Watchlist-lane enable flag from 0034_watchlist_enabled.sql. Like the
   * profiler, the watchlist lane (replies + DMs to the always-reply watchlist
   * people) is decoupled from the master Start/Pause — it runs for active AND
   * paused instances and gates only on this flag, so watched accounts keep
   * getting drafts while the keyword pipeline is paused. Absence means enabled.
   */
  watchlist_enabled?: boolean;
  /**
   * Goal-run + pipeline-session state from 0021_pipeline_goal.sql. When
   * goal_target/goal_started_at are set, a goal-run is active: the drafter's
   * effective cap is raised to >= target and the pipeline auto-pauses once that
   * many approvals have been produced since goal_started_at. Optional on the
   * type so fixtures can omit them.
   */
  pipeline_started_at?: string | null;
  goal_target?: number | null;
  goal_started_at?: string | null;
  /**
   * Tailored-discovery config from 0032_discovery_config.sql (both jsonb).
   *   - discovery_config: the saved DEFAULT (Configure-agent page).
   *   - run_config: the ACTIVE per-run override (Start all → Tailor this run),
   *     merged over the default field-by-field; null = no override.
   * Raw jsonb; resolved + validated via resolveDiscoveryConfig() at use.
   * Optional on the type so fixtures can omit them ('{}' / null in prod).
   */
  discovery_config?: unknown;
  run_config?: unknown;
  /**
   * Per-lane enable state (0049_agent_instances_lane_config.sql, jsonb). The
   * relationship-DM lane gates from lane_config.dms.relationship_dms_enabled and
   * stays independent from the reply/legacy DM toggles.
   */
  lane_config?: unknown;
  /**
   * Account Feeder config from 0051_account_feeder.sql (jsonb, nullable). Holds the
   * style-mixer knobs + pinnedStyleHandle for the "voice of our posts" feature.
   * NULL = feeder OFF (no STYLE injection). Parsed with readPinnedHandle /
   * AccountFeederConfigSchema at use. Optional on the type so fixtures can omit it.
   */
  account_feeder_config?: unknown;
}

export type XInternWorkerKind =
  | "discovery"
  | "classifier"
  | "drafter"
  | "send"
  | "profiler"
  | "watchlist"
  | "notifications";

/**
 * Whether a specific worker is enabled for an instance. Default-on: only an
 * explicit `false` disables it, so a row/fixture missing the flag (or a column
 * not yet backfilled) keeps the pre-0019 "all workers run" behaviour.
 */
export function isWorkerEnabled(inst: ActiveInstance, kind: XInternWorkerKind): boolean {
  const flag = inst[`${kind}_enabled` as const];
  return flag !== false;
}

// Single source of truth for the worker-facing instance row. Both selectors
// below pull the same columns; they differ only in the status filter, so the
// column list can't drift between them.
async function listXInternInstancesByStatus(
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
      auto_send_enabled,
      auto_send_min_delay_sec,
      auto_send_max_delay_sec,
      auto_send_max_per_hour,
      pending_drafts_cap,
      lead_backlog_cap,
      objective,
      brand_config,
      classifier_threshold,
      icp_config,
      discovery_enabled,
      classifier_enabled,
      drafter_enabled,
      notifications_enabled,
      send_enabled,
      reply_send_enabled,
      profiler_enabled,
      watchlist_enabled,
      dm_autodraft_enabled,
      pipeline_started_at,
      goal_target,
      goal_started_at,
      discovery_config,
      run_config,
      lane_config,
      account_feeder_config
    from noelle.agent_instances
    where role = 'x_intern'
      and status = any(${statuses as string[]})
  `;
  return [...rows];
}

// "Should the pipeline workers do work?" — discovery/classifier/drafter/send
// only act on rows returned here. Status flips on the dashboard Start/Pause
// button propagate within one poll cycle. Per-worker enable flags are returned
// too; each worker gates on its own via isWorkerEnabled.
export async function listActiveXInternInstances(
  sql: Sql,
): Promise<ActiveInstance[]> {
  return listXInternInstancesByStatus(sql, ["active"]);
}

// The profiler is decoupled from Start/Pause (0024): watchlist profiling is
// passive enrichment, useful while the pipeline is paused. So it sees active
// AND paused instances and gates only on profiler_enabled in its onTick.
export async function listProfilerXInternInstances(
  sql: Sql,
): Promise<ActiveInstance[]> {
  return listXInternInstancesByStatus(sql, ["active", "paused"]);
}

// Discovery/classifier/drafter use this so they can run the always-on WATCHLIST
// lane (replies to watchlist people) for paused instances too — not just active
// ones. Each worker branches on inst.status: when 'active' it runs both the
// keyword lane and the watchlist lane; when 'paused' it runs only the watchlist
// lane (gated on watchlist_enabled). See 0034_watchlist_enabled.sql.
export async function listWatchlistOrActiveXInternInstances(
  sql: Sql,
): Promise<ActiveInstance[]> {
  return listXInternInstancesByStatus(sql, ["active", "paused"]);
}

// The send worker also runs for paused instances: an operator can schedule a
// batch of replies for auto-send (auto_send_target_at) and expect them to fire
// on their staggered schedule even while the rest of the pipeline (discovery /
// classify / draft) is paused. Per-instance gating still applies via
// isWorkerEnabled(inst, "send"); a paused instance with nothing due is a
// cheap no-op tick.
export async function listSendXInternInstances(
  sql: Sql,
): Promise<ActiveInstance[]> {
  return listXInternInstancesByStatus(sql, ["active", "paused"]);
}
