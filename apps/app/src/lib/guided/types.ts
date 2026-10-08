/**
 * Types for the guided setup workflow.
 *
 * Pure + client-safe: no DB import, no `server-only`. `signals.ts` is the only
 * module in this directory that touches Postgres, so every rule about what a
 * step means lives in code that can be unit tested with plain objects.
 */

import { SOCIAL_AGENT_ROLES, type AgentRole } from "@noelle/contracts";

/** Supported social channel roles from the shared contract. */
export const INTERN_ROLES = SOCIAL_AGENT_ROLES;
export type InternRole = AgentRole;

/** One hired intern, reduced to just what the guided flow needs to decide. */
export interface GuidedAgentSignal {
  role: InternRole;
  instanceId: string;
  displayName: string | null;
  /**
   * `active` | `paused` | `provisioning_alpha` | `retired`. Not DB-constrained.
   *
   * `provisioning_alpha` is a historical pending state. Channel setup recovers
   * it to paused without enabling publication.
   */
  status: string;
  /** A current same-org targeting row; disabled Video sources do not count. */
  hasTargeting: boolean;
  /** `agent_instances.reply_send_enabled` — the master send kill switch (0081). */
  replySendEnabled: boolean;
}

/**
 * A snapshot of everything the guided flow needs, loaded once per render.
 * Every field is derived from an existing table; nothing here needs a migration.
 */
export interface GuidedSignals {
  /** `noelle.vaults.wizard_stage`. `null` = wizard never run. */
  vaultStage: "light" | "medium" | "rich" | null;
  /**
   * A token the WORKERS can actually use: `kind='apify'`, `active`, `in_use`,
   * not invalid, not exhausted. Pasted tokens land spare (`in_use=false`).
   */
  hasApifyToken: boolean;
  agents: GuidedAgentSignal[];
  /** Own lead with a coherent current parent, or a legacy unassigned lead. */
  discoveredAny: boolean;
  /** Own draft with a coherent own source and current source parent. */
  draftedAny: boolean;
  /** De-duplicated pending approvals across every agent. */
  pendingApprovals: number;
  /** A coherent approved/sent/skipped row records a nonautomated decision. */
  actionedAny: boolean;
  /** X posting creds resolve (cookies via api-vm whoami, or `x_api_tokens`). */
  xPostingReady: boolean;
}

/**
 * - `done`    — the predicate is satisfied.
 * - `current` — the one step the operator should do next.
 * - `todo`    — actionable, but not next.
 * - `blocked` — a prerequisite is missing; clicking it would strand the operator.
 * - `waiting` — the operator's part is finished; the system owes them output.
 */
export type GuidedStepState = "done" | "current" | "todo" | "blocked" | "waiting";

/**
 * - `required`    — counts toward progress; the flow is incomplete without it.
 * - `recommended` — improves quality, never blocks. (Voice/vault grounding is
 *   fail-open: the drafter treats zero anchors as a normal degraded state.)
 * - `advanced`    — opt-in, and the only tier that can make Noelle post.
 */
export type GuidedTier = "required" | "recommended" | "advanced";

export type GuidedStepId =
  | "voice"
  | "data-source"
  | "hire"
  | "targeting"
  | "activate"
  | "approve"
  | "publishing";

export interface GuidedStep {
  id: GuidedStepId;
  tier: GuidedTier;
  eyebrow: string;
  title: string;
  blurb: string;
  cta: string;
  /** Where the CTA goes. Receives signals so it can deep-link a hired agent. */
  href: (orgSlug: string, signals: GuidedSignals) => string;
  isComplete: (signals: GuidedSignals) => boolean;
  /** Non-null = why the operator cannot start this step yet. */
  blockedBy?: (signals: GuidedSignals) => string | null;
  /** Non-null = the operator is done and the pipeline owes them output. */
  waitingOn?: (signals: GuidedSignals) => string | null;
  /**
   * Extra context for a step that is actionable but whose plain reading would
   * mislead. Shown alongside the blurb; never changes the step's state.
   */
  note?: (signals: GuidedSignals) => string | null;
}

export interface GuidedStepView {
  step: GuidedStep;
  state: GuidedStepState;
  href: string;
  /** Explains `blocked` / `waiting`, or carries a `todo` step's `note`. */
  reason: string | null;
}

export interface GuidedPlan {
  steps: GuidedStepView[];
  requiredDone: number;
  requiredTotal: number;
  /** Every `required` step is done. `advanced` and `recommended` are ignored. */
  complete: boolean;
  currentId: GuidedStepId | null;
  /** One-line summary of where the operator stands. */
  status: string;
  /** Truths about this org's setup that the operator would otherwise learn by waiting. */
  caveats: string[];
}

/** Failed reads cannot establish either progress or an empty organization. */
export type GuidedSetup =
  | { status: "ready"; plan: GuidedPlan; dismissed: boolean }
  | { status: "unavailable"; dismissed: boolean };
