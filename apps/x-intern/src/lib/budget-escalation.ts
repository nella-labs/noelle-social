import type { Sql } from "postgres";
import type { Logger } from "./logger.js";
import { BudgetExceededError, notifyBudgetBlockedOnce, type BudgetAlertDeps } from "@noelle/runtime";

/**
 * Persist a cap-block event when the agent's escalate_on_cap policy is
 * enabled. Surfaced in the UI as the "N drafts blocked by your monthly
 * cap" banner / feed (follow-up UI work).
 *
 * One row per blocked draft attempt. The UI groups them client-side by
 * (org_id, month) for the headline count, and links each individual row
 * to the lead that was blocked so the founder can decide whether to
 * raise the cap or wait it out.
 *
 * No-op when escalate_on_cap=false. SQL failures are logged + swallowed
 * — a budget escalation insert failure must never cascade into a
 * dropped lead.
 *
 * Also tells the operator, once per budget period. Recording a row is not
 * telling anyone: the banner this table was built for is still "follow-up UI
 * work", so without a notification the agents simply go quiet and the operator
 * finds out by noticing. Pass a notifier to enable it; omit for callers that
 * only want the row.
 */
export interface RecordBudgetEscalationArgs {
  sql: Sql;
  log: Logger;
  err: BudgetExceededError;
  orgId: string;
  instanceId: string;
  leadId: string | null;
  escalateOnCap: boolean;
  /** Omit to record silently. */
  notifier?: BudgetAlertDeps["notifier"];
}

export async function recordBudgetEscalation(
  args: RecordBudgetEscalationArgs,
): Promise<void> {
  if (!args.escalateOnCap) return;
  try {
    await args.sql`
      insert into noelle.budget_escalations
        (agent_instance_id, org_id, lead_id, attempted_cents, cap_cents)
      values
        (${args.instanceId}, ${args.orgId}, ${args.leadId},
         ${args.err.spentCents + args.err.estimatedCents}, ${args.err.capCents})
    `;
  } catch (insertErr) {
    args.log.error(
      {
        instanceId: args.instanceId,
        err: (insertErr as Error).message,
      },
      "failed to insert budget escalation row",
    );
  }
  if (args.notifier) {
    await notifyBudgetBlockedOnce(
      { sql: args.sql, notifier: args.notifier, log: args.log },
      { orgId: args.orgId, err: args.err },
    );
  }
}
