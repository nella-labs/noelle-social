import type { AgentRole, EngineHandle } from "./types.js";

/**
 * One LLM call → one noelle.llm_calls row. `callAgentModel` calls
 * `record` after every engine attempt (success, engine failure, timeout)
 * AND after a pre-flight `BudgetExceededError` so operators can see the
 * blocked attempt.
 *
 * The PostgreSQL recorder persists receipts and settles confirmed admissions
 * atomically. Unresolved charges retain their durable budget hold.
 */

export type SpendStatus = "ok" | "error" | "timeout" | "budget_exceeded";
export const SPEND_COST_BASES = ["provider_reported", "token_estimate", "failure_estimate", "not_dispatched", "unknown"] as const;
export type SpendCostBasis = typeof SPEND_COST_BASES[number];

/**
 * The engine a spend row bills under. LLM engines come from EngineHandle;
 * "apify" is the non-LLM data-fetch engine (HarvestAPI actors, billed per
 * result, not per token) so Apify cost lands in the same noelle.llm_calls ledger
 * and the dashboard can split AI vs Apify on this field.
 */
export type SpendEngine = EngineHandle["engine"] | "apify" | "xapi";

export type SpendRow = {
  orgId: string;
  /** May be null for system-level calls that aren't tied to a hired agent. */
  instanceId: string | null;
  agentRole: AgentRole;
  /** "drafter" | "classifier" | "discovery" | "send" | future workers. */
  worker: string;
  engine: SpendEngine;
  model: string;
  /** Spend bucket the cap check used. Same string the dashboard groups by. */
  bucket: string;
  inputTokens: number;
  outputTokens: number;
  /** Whole cents of recorded accounting; the basis identifies an amount or estimate. */
  cents: number;
  /** Absent on older callers; persisted as unknown rather than inferred from status. */
  costBasis?: SpendCostBasis;
  /** Wall-clock latency of the engine.call(), null when the call never fired. */
  latencyMs: number | null;
  status: SpendStatus;
  /** When the engine call started (or would have started, for budget_exceeded). */
  startedAt: Date;
  /**
   * The noelle.connections row id this call billed against, for per-token spend
   * attribution. Set on engine='apify' rows that used a DB-backed token; null for
   * LLM rows and for Apify runs on the env-fallback token.
   */
  credentialId?: string | null;
  /** Durable admission identity, shared with its idempotent receipt. */
  attemptId?: string;
};

export interface SpendRecorder {
  record(row: SpendRow): Promise<void>;
}

/** Used by tests and any boot path that can't talk to the DB. */
export const noopSpendRecorder: SpendRecorder = {
  async record() {
    /* no-op */
  },
};
