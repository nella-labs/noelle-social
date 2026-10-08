import type { Sql } from "postgres";
import { BoundedPgSession, PgOperationError } from "./boundedPgSession.js";
import type { BudgetPeriod } from "./pgBudgetAdapters.js";
import type { NotifyResult } from "./notifier.js";

export type BudgetNotificationResult = "notified" | "already-notified" | "in-progress" | "failed";
const DEADLINE_MS = 15_000;
const sessions = new WeakMap<Sql, BoundedPgSession>();
function sessionFor(parent: Sql): BoundedPgSession {
  let session = sessions.get(parent);
  if (!session) {
    session = new BoundedPgSession(parent, { deadlineMs: DEADLINE_MS, maxPending: 32, idleTimeoutMs: 1000 });
    sessions.set(parent, session);
  }
  return session;
}

/** Avoid resolving secrets again once this calendar window has an accepted receipt. */
export async function hasBudgetNotification(parent: Sql, orgId: string, period: BudgetPeriod): Promise<boolean> {
  return sessionFor(parent).run(async sql => {
    const [row] = await sql<{ accepted: boolean }[]>`select exists(
      select 1 from noelle.budget_block_notifications
      where org_id=${orgId} and budget_period=${period}
        and period_started_at=date_trunc(${period},statement_timestamp())
    ) as accepted`;
    return row?.accepted === true;
  });
}

/** One owned session holds the notification lease through bounded send and receipt commit. */
export async function sendBudgetNotificationOnce(
  parent: Sql, orgId: string, period: BudgetPeriod,
  send: (timeoutMs: number) => Promise<NotifyResult>,
): Promise<BudgetNotificationResult> {
  const deadline = performance.now() + DEADLINE_MS;
  return sessionFor(parent).run(sql => sql.begin(async tx => {
    await tx`set local lock_timeout='1s'`;
    await tx`set local statement_timeout='1s'`;
    await tx`set local idle_in_transaction_session_timeout='10s'`;
    const [lease] = await tx<{ acquired: boolean; period_start: Date }[]>`select
      pg_try_advisory_xact_lock(hashtextextended('budget-notification:' || ${orgId}::uuid::text || ':' || ${period},0)) as acquired,
      date_trunc(${period},statement_timestamp()) as period_start`;
    if (!lease?.acquired) return "in-progress";
    const [stored] = await tx<{ accepted: boolean }[]>`select exists(
      select 1 from noelle.budget_block_notifications
      where org_id=${orgId} and budget_period=${period} and period_started_at=${lease.period_start}
    ) as accepted`;
    if (stored?.accepted) return "already-notified";

    // Leave time for the receipt transaction after queueing and connection setup.
    const timeoutMs = Math.min(8000, Math.floor(deadline - performance.now() - 1500));
    if (timeoutMs < 1) throw new PgOperationError("deadline");
    const receipt = await send(timeoutMs);
    if (receipt?.status !== "sent" || receipt.channel !== "pushover"
      || typeof receipt.request !== "string" || !receipt.request.trim() || receipt.request.length > 65_536) return "failed";
    await tx`insert into noelle.budget_block_notifications
      (org_id,budget_period,period_started_at,notify_channel,provider_request)
      values (${orgId},${period},${lease.period_start},${receipt.channel},${receipt.request})`;
    return "notified";
  }));
}
