import type { Fragment, Sql, TransactionSql } from "postgres";

/** SQL counterpart of the reply-review contract, plus the explicit human-review gate. */
export function unattendedReplyReviewSql(sql: Sql | TransactionSql, payload: Fragment): Fragment {
  return sql`(${payload}->'verifier_meta'->'pass' = 'true'::jsonb
    and ${payload}->'verifier_meta'->'judgeOk' = 'true'::jsonb
    and (${payload}->'human_review_required' is distinct from 'true'::jsonb
      or ${payload}->'human_send_approved' = 'true'::jsonb))`;
}
