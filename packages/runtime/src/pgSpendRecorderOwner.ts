import type { Sql } from "postgres";
import { BoundedPgSession, PgOperationError } from "./boundedPgSession.js";
import { settleSpendAttempt } from "./pgSpendSettlement.js";
import type { SpendRow } from "./spendRecorder.js";
import { spendReceiptJson } from "./pgSpendReceiptJson.js";

export type SpendRecordingCategory = "deadline" | "queue_full" | "database" | "connection";

/** The category is safe to report; database queries and parameters are omitted. */
export class SpendRecordingError extends Error {
  readonly category: SpendRecordingCategory;
  constructor(category: SpendRecordingCategory) {
    super(`Spend recording failed: ${category}`);
    this.name = "SpendRecordingError";
    this.category = category;
  }
}

export interface SpendRecordingFailure {
  category: SpendRecordingCategory;
  orgId: string;
  instanceId: string | null;
  agentRole: SpendRow["agentRole"];
  worker: string;
  engine: SpendRow["engine"];
}

export interface PgSpendRecorderOwnerConfig {
  deadlineMs: number;
  maxPending: number;
  idleTimeoutMs: number;
}

/** One bounded receipt writer per parent pool; failed writes are observable and never retried. */
export class PgSpendRecorderOwner {
  private readonly session: BoundedPgSession;
  constructor(parent: Sql, config: PgSpendRecorderOwnerConfig) {
    this.session = new BoundedPgSession(parent, config);
  }
  async record(row: SpendRow, onFailure: (failure: SpendRecordingFailure) => void): Promise<void> {
    try {
      await this.session.run(async (sql) => {
        if (row.attemptId) return settleSpendAttempt(sql, row);
        await sql`
          insert into noelle.llm_calls
          select (jsonb_populate_record(null::noelle.llm_calls,
            jsonb_build_object('id', gen_random_uuid()) || ${sql.json(spendReceiptJson(row))}::jsonb)).*
        `;
      });
    } catch (error) {
      const category = error instanceof PgOperationError ? error.category : "database";
      const { orgId, instanceId, agentRole, worker, engine } = row;
      try { onFailure({ category, orgId, instanceId, agentRole, worker, engine }); } catch { /* Reporting cannot hold a receipt. */ }
      throw new SpendRecordingError(category);
    }
  }
}
