/**
 * Re-export the Database shape + row types from @noelle/types.
 *
 * Source of truth: packages/types/src/database.ts (hand-rolled snapshot
 * regenerated via `pnpm --filter @noelle/types generate`).
 *
 * Type aliases below are convenience names matching what the route files
 * already import. Direct row types come from
 * `Database["noelle"]["Tables"][T]["Row"]`.
 */

import type { Database } from "@noelle/types";

export type { Database };

type NoelleTables = Database["noelle"]["Tables"];

export type NoelleOrganization = NoelleTables["organizations"]["Row"];
export type NoelleOrgMember = NoelleTables["org_members"]["Row"];
/**
 * Generated row type + hand-rolled extension for the policy columns added
 * in `infra/cloudsql/schema/0010_agent_policies.sql`. The generator still
 * reflects the pre-0010 Supabase schema so we layer the new fields here
 * until the next regen pass.
 */
export type NoelleAgentInstance = NoelleTables["agent_instances"]["Row"] & {
  budget_alert_pct: number;
  escalate_on_cap: boolean;
  pause_on_5xx: boolean;
  notify_low_confidence: boolean;
  // 0017_agent_objective.sql — operator mission. NULL = use manifest default
  // (collapse via resolveObjective from @noelle/runtime).
  objective: string | null;
  // 0042_classifier_threshold.sql — operator-set classifier q-score (0-100).
  // Overrides LINKEDIN_Q_THRESHOLD when set; null = use the env default.
  classifier_threshold: number | null;
  // 0051_account_feeder.sql — Account Feeder tuning knobs (shape =
  // AccountFeederConfigSchema, incl. pinnedStyleHandle). NULL = feeder off.
  account_feeder_config: { pinnedStyleHandle?: string } & Record<string, unknown> | null;
  // 0015_auto_send.sql
  auto_send_enabled: boolean;
  auto_send_min_delay_sec: number;
  auto_send_max_delay_sec: number;
  auto_send_max_per_hour: number;
  // 0026_auto_defer_dms.sql — when true, sending a reply auto-parks that lead's
  // DM (approval status='deferred') onto the person's Contacts page. Default false.
  auto_defer_dms: boolean;
  // 0012_pending_drafts_cap.sql / 0013_lead_backlog_cap.sql — backpressure caps. Null = no cap.
  pending_drafts_cap: number | null;
  lead_backlog_cap: number | null;
  // 0019_worker_enabled.sql — per-worker enable flags. Master switch is `status`;
  // within an active instance these run each worker independently. Default true.
  discovery_enabled: boolean;
  classifier_enabled: boolean;
  drafter_enabled: boolean;
  send_enabled: boolean;
  // Master "reply sending" switch (0081). OFF by default. When false, replies are
  // drafted + queued for approval but nothing posts: the X send worker and the
  // LinkedIn actuator queue both gate on it. Flipped from the agent page.
  reply_send_enabled: boolean;
  // 0089_actuator_remote_control.sql — remote start/stop of the browser actuator
  // (the "hands"). desired_state NULL = no remote override (local autonomy
  // governs); 'running' = run persistently (NOT send-consent — reply_send still
  // gates posting); 'stopped' = fully paused. command_at bumps on every change;
  // last_state/seen_at are the extension's reported actual state + liveness.
  actuator_desired_state: "running" | "stopped" | null;
  actuator_command_at: string | null;
  actuator_last_state: "running" | "idle" | null;
  actuator_seen_at: string | null;
  // 0024_profiler_enabled.sql — profiler enable flag. Decoupled from `status`:
  // the profiler runs for active AND paused instances, gated only on this. Default true.
  profiler_enabled: boolean;
  // 0034_watchlist_enabled.sql — always-on watchlist lane flag. Like the profiler,
  // it runs for active AND paused instances (replies to watched people). Default true.
  watchlist_enabled: boolean;
  // 0036_dm_autodraft_enabled.sql — auto-draft a DM alongside each reply. Default
  // FALSE (opt-in): the drafter is replies-only unless the operator turns this on.
  dm_autodraft_enabled: boolean;
  // 0039_linkedin_intro_dm_enabled.sql — Lyra's one-time intro-DM lane (per
  // connection). Default FALSE (opt-in); never runs during a goal-run.
  linkedin_intro_dm_enabled: boolean;
  // 0021_pipeline_goal.sql — pipeline-session + goal-run state. Nullable.
  pipeline_started_at: string | null;
  goal_target: number | null;
  goal_started_at: string | null;
  // 0027_last_goal_started_at.sql — sticky copy of goal_started_at, stamped on
  // every goal-run start and never cleared. Anchors the inbox "Last batch" filter.
  last_goal_started_at: string | null;
  // 0032_discovery_config.sql — tailored discovery. discovery_config is the
  // saved default; run_config is the active per-run override (null = none).
  // Raw jsonb; validated against DiscoveryConfigSchema at use.
  discovery_config: unknown;
  run_config: unknown;
  // 0085_run_schedule.sql — recurring scheduled run. run_schedule is the saved
  // schedule config (shape = RunScheduleSchema; validated at use); run_schedule_next_at
  // is the next computed fire time the api-vm scheduler triggers on. Both null = no
  // schedule (button-only behaviour).
  run_schedule: unknown;
  run_schedule_next_at: string | null;
};
export type NoelleApproval = NoelleTables["approvals"]["Row"] & {
  // 0015_auto_send.sql — populated only when the parent instance has
  // auto_send_enabled; NULL means "human-review row" (existing behaviour).
  auto_send_target_at: string | null;
};
/**
 * Generated row type + hand-rolled extension for the classifier columns
 * added in `infra/cloudsql/schema/0005_leads_full_schema.sql`. The
 * generator still reflects the pre-0005 schema (only the JSONB payload
 * snapshot), so we layer the real columns here until the next regen pass.
 * The classifier worker writes these directly
 * (apps/x-intern/src/lib/leads-db.ts §markLeadClassified) — without them
 * on the type the dashboard can only ever see the stale payload fallback,
 * which the discovery worker doesn't populate.
 */
export type NoelleLead = NoelleTables["leads"]["Row"] & {
  tier: "T1" | "T2" | "T3" | null;
  classifier_label: string | null;
  classifier_score: number | null;
  // 0005_leads_full_schema columns the generator doesn't reflect yet.
  author_handle: string | null;
  author_id: string | null;
  // Discovery sets this true when a lead's author is on the watchlist (the
  // always-reply accounts). Filtered on in SQL; surfaced here so the inbox can
  // collapse a watched person to just their newest post (?wlLatest=on).
  priority: boolean | null;
  // 0005_leads_full_schema §platform — 'x' (default) | 'linkedin' | 'reddit'.
  // Drives which approval stream a lead belongs to (the LinkedIn intern's
  // queue filters on platform='linkedin'). The generator predates the column.
  platform: SocialPlatform;
};
export type NoelleDraft = NoelleTables["drafts"]["Row"];
export type NoelleOrgSpendMonth = NoelleTables["org_spend_month"]["Row"];
export type NoelleVault = NoelleTables["vaults"]["Row"];
export type NoelleVaultAnchorUsage = NoelleTables["vault_anchor_usage"]["Row"];
export type NoelleVaultWizardAnswers = NoelleTables["vault_wizard_answers"]["Row"];
export type VaultStatus = NoelleVault["status"];
export type VaultWizardStage = NonNullable<NoelleVault["wizard_stage"]>;

/**
 * Worker run heartbeat. In Cloud SQL this is `noelle.worker_runs` (the old
 * Supabase `sync_runs` table no longer exists post-Phase-4). We hand-roll
 * the shape here instead of taking it from `@noelle/types` because the
 * generated types still reflect the legacy Supabase schema until the next
 * regen pass.
 */
export interface NoelleSyncRun {
  id: string;
  worker: WorkerKind;
  started_at: string;
  finished_at: string | null;
  rows_processed: number | null;
  error: string | null;
}

export type WorkerKind = "discovery" | "classifier" | "drafter" | "send";

/**
 * Contacts CRM. Hand-rolled (not from `@noelle/types`) because these tables
 * were added in `infra/cloudsql/schema/0023_persons_crm.sql`, after the last
 * generated snapshot. A person is org-scoped and reachable on one or more
 * social platforms via `noelle.person_social_accounts`.
 */
export type SocialPlatform = "x" | "linkedin" | "reddit";

export interface NoellePerson {
  id: string;
  org_id: string;
  display_name: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export interface NoellePersonSocialAccount {
  id: string;
  org_id: string;
  person_id: string;
  platform: SocialPlatform;
  handle: string | null;
  url: string | null;
  created_at: string;
  updated_at: string;
}

/* Narrow string-column enums for UI use. These mirror the CHECK constraints
 * in supabase/migrations/0001_noelle_schema.sql. If a constraint changes,
 * regenerate @noelle/types and update these unions. */
export type { AgentRole } from "@noelle/contracts";
export type AgentInstanceStatus =
  | "active"
  | "provisioning_alpha"
  | "paused"
  | "retired";
export type ApprovalStatus = "pending" | "sent" | "skipped" | "expired";
export type OrgMemberRole = "owner" | "member";
export type OrgPlan = "alpha" | "starter" | "pro" | "enterprise";
