import type { Fragment, Sql, TransactionSql } from "postgres";

/** A nullable timestamp fragment: invalid source values never abort a query. */
export function sourceTimestampSql(
  sql: Sql | TransactionSql,
  value: Fragment,
  format: "iso" | "postgres" = "iso",
): Fragment {
  return sql`case when ${format === "iso" ? sql`${value} ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T'` : sql`${value} is not null`}
    and pg_input_is_valid(${value}, 'timestamp with time zone')
    then (${value})::timestamptz end`;
}
