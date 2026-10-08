import type { Sql } from "postgres";
import { BudgetExceededError } from "./budgetBucket.js";
import { resolveBudgetPeriod, type BudgetPeriod } from "./pgBudgetAdapters.js";
import { hasBudgetNotification, sendBudgetNotificationOnce, type BudgetNotificationResult } from "./budgetAlertDb.js";
import type { PreparedNotifier } from "./notifier.js";

/**
 * Tell the operator the first time the budget cap stops work in a period.
 *
 * Cap-block events and accepted notification receipts have separate storage.
 * A failed or unconfigured notification remains retryable, while an accepted
 * receipt deduplicates across worker restarts and concurrent worker pools.
 */
export type BudgetAlertDeps = {
  sql: Sql;
  notifier: Pick<PreparedNotifier, "prepare">;
  log: { info: (o: unknown, m: string) => void; error: (o: unknown, m: string) => void };
};

export type BudgetAlertResult = BudgetNotificationResult;

const usd = (cents: number) => `$${(cents / 100).toFixed(2)}`;

export async function notifyBudgetBlockedOnce(
  deps: BudgetAlertDeps,
  args: {
    orgId: string;
    err: BudgetExceededError;
    /** Defaults to the configured window, so the alert resets when the cap does. */
    period?: BudgetPeriod;
  },
): Promise<BudgetAlertResult> {
  const period = resolveBudgetPeriod(args.period);
  try {
    if (await hasBudgetNotification(deps.sql, args.orgId, period)) return "already-notified";
    const prepared = await deps.notifier.prepare(args.orgId);

    const { spentCents, estimatedCents, capCents, layer } = args.err;
    const result = await sendBudgetNotificationOnce(deps.sql, args.orgId, period, timeoutMs => prepared.notify({
      title: `Noelle — ${period}ly budget cap reached`,
      message:
        `The ${layer} cap is ${usd(capCents)} (${usd(spentCents)} spent so far; ` +
        `next call ~${usd(estimatedCents)}). Further calls covered by this cap pause until the ${period} rolls over.\n` +
        `To keep going now: scripts/cap-pause.sh ${period === "week" ? "week" : "today"}`,
    }, { timeoutMs }));
    if (result === "notified") deps.log.info({ orgId: args.orgId, layer, capCents }, "budget cap reached — operator notified");
    else if (result === "failed") deps.log.error({ orgId: args.orgId }, "budget cap notification was not accepted");
    return result;
  } catch (err) {
    // Never let an alert failure cascade into the worker. The cap has already
    // done its job by this point; this is only the telling.
    deps.log.error({ orgId: args.orgId, err: err instanceof Error ? err.message : "notification failure" }, "budget cap alert failed");
    return "failed";
  }
}
