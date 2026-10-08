import type { Sql } from "postgres";
import { PgOperationError } from "./boundedPgSession.js";
import type { SpendRow } from "./spendRecorder.js";
import { spendReceiptJson } from "./pgSpendReceiptJson.js";

/** Receipt insertion and confirmed settlement share a transaction and an exact tenant identity. */
export async function settleSpendAttempt(sql: Sql, row: SpendRow): Promise<void> {
  await sql.begin(async (tx) => {
    if (row.costBasis === "not_dispatched" && (row.status !== "error" || row.inputTokens !== 0 ||
      row.outputTokens !== 0 || row.cents !== 0 || row.latencyMs !== null)) throw new PgOperationError("database");
    const payload = spendReceiptJson(row);
    const held = await tx`
      select id from noelle.llm_budget_reservations
      where id = ${row.attemptId!} and org_id = ${row.orgId}
        and agent_instance_id = ${row.instanceId} and agent_role = ${row.agentRole}
        and worker = ${row.worker} and engine = ${row.engine}
        and model = ${row.model} and bucket = ${row.bucket}
      for update
    `;
    if (!held.length || row.status === "budget_exceeded") throw new PgOperationError("database");
    const inserted = await tx`
      insert into noelle.llm_calls
      select (jsonb_populate_record(null::noelle.llm_calls,
        jsonb_build_object('id', gen_random_uuid()) || ${tx.json(payload)}::jsonb)).*
      on conflict (attempt_id) do nothing returning id
    `;
    if (!inserted.length) {
      const same = await tx`
        select id from noelle.llm_calls c
        where attempt_id = ${row.attemptId!} and org_id = ${row.orgId}
          and agent_instance_id = ${row.instanceId} and agent_role = ${row.agentRole}
          and worker = ${row.worker} and engine = ${row.engine} and model = ${row.model}
          and bucket = ${row.bucket} and input_tokens is not distinct from ${row.inputTokens}
          and output_tokens is not distinct from ${row.outputTokens} and cents = ${row.cents}
          and latency_ms is not distinct from ${row.latencyMs} and status = ${row.status}
          and started_at = ${row.startedAt} and credential_id is not distinct from ${row.credentialId ?? null}
          and coalesce(to_jsonb(c)->>'cost_basis', 'unknown') =
            coalesce(to_jsonb(jsonb_populate_record(null::noelle.llm_calls, ${tx.json(payload)}::jsonb))->>'cost_basis', 'unknown')
      `;
      if (!same.length) throw new PgOperationError("database");
    }
    // Stored accounting or a confirmed zero-cost refusal settles capacity. Unknown outcomes retain it.
    await tx`update noelle.llm_budget_reservations r set settled_at = coalesce(r.settled_at, clock_timestamp())
      where r.id = ${row.attemptId!} and exists (select 1 from noelle.llm_calls c
        where c.attempt_id = r.id and c.org_id = r.org_id
          and c.agent_instance_id is not distinct from r.agent_instance_id and c.agent_role = r.agent_role
          and c.worker = r.worker and c.engine = r.engine and c.model = r.model and c.bucket = r.bucket
          and ((c.status = 'ok' and coalesce(to_jsonb(c)->>'cost_basis','unknown') in ('provider_reported','token_estimate'))
            or (c.status = 'error' and coalesce(to_jsonb(c)->>'cost_basis','unknown') = 'not_dispatched'
              and c.input_tokens = 0 and c.output_tokens = 0 and c.cents = 0 and c.latency_ms is null)))`;
  });
}
