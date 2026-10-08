import type { Fragment, Sql, TransactionSql } from "postgres";
import { NOTIFICATION_MAX_AGE_HOURS } from "./notificationWindow.js";

/** Notifications use their conversation window; other replies use the cold-post ceiling. */
export function xReplyAgeCutoffSql(sql: Sql | TransactionSql, payload: Fragment, maxAgeHours: number): Fragment {
  return sql`now() - (case when ${payload}->>'source' = 'notification'
    then make_interval(hours => ${NOTIFICATION_MAX_AGE_HOURS})
    else make_interval(hours => ${maxAgeHours}) end)`;
}
