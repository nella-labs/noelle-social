import type { JSONValue } from "postgres";
import { PgOperationError } from "./boundedPgSession.js";
import { SPEND_COST_BASES, type SpendRow } from "./spendRecorder.js";

/** One receipt mapping supports additive columns during a rolling schema update. */
export function spendReceiptJson(row: SpendRow): JSONValue {
  for (const value of [row.inputTokens, row.outputTokens, row.cents, row.latencyMs ?? 0]) {
    if (!Number.isInteger(value) || value < 0 || value > 2_147_483_647) throw new PgOperationError("database");
  }
  const costBasis = row.costBasis ?? "unknown";
  if (!SPEND_COST_BASES.includes(costBasis)) {
    throw new PgOperationError("database");
  }
  return {
    org_id: row.orgId, agent_instance_id: row.instanceId, agent_role: row.agentRole,
    worker: row.worker, engine: row.engine, model: row.model, bucket: row.bucket,
    input_tokens: row.inputTokens, output_tokens: row.outputTokens, cents: row.cents,
    latency_ms: row.latencyMs, status: row.status, started_at: row.startedAt.toISOString(),
    credential_id: row.credentialId ?? null, attempt_id: row.attemptId ?? null, cost_basis: costBasis,
  };
}
