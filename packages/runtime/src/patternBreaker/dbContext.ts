import type { ParameterOrFragment, RowList, Sql, TransactionSql } from "postgres";
import { UuidSchema } from "@noelle/contracts";
import { BoundedPgSession } from "../boundedPgSession.js";

export const PATTERN_ROLES = [
  "x_intern",
  "linkedin_intern",
  "reddit_intern",
  "video_intern",
] as const;
export type PatternRole = (typeof PATTERN_ROLES)[number];
export interface PatternScope {
  orgId: string;
  agentInstanceId: string;
  role: PatternRole;
  /** Operator mutations and reads recheck this verified user's membership. */
  userId?: string;
}
export type PatternQuery = <T extends readonly (object | undefined)[]>(
  template: TemplateStringsArray,
  ...parameters: readonly ParameterOrFragment<never>[]
) => Promise<RowList<T>>;
/** The dashboard's readSql owns READ ONLY dispatch; sql only constructs synchronous fragments. */
export interface PatternReadClient {
  query: PatternQuery;
  fragments: Sql;
}
export type PatternSql = Sql | TransactionSql;
const sessions = new WeakMap<Sql, BoundedPgSession>();

export function validPatternScope(scope: PatternScope): boolean {
  return (
    UuidSchema.safeParse(scope.orgId).success &&
    UuidSchema.safeParse(scope.agentInstanceId).success &&
    PATTERN_ROLES.includes(scope.role) &&
    (scope.userId === undefined || UuidSchema.safeParse(scope.userId).success)
  );
}
export function patternRead<T>(
  client: Sql | PatternReadClient,
  read: (query: PatternQuery, fragments: Sql) => Promise<T>,
): Promise<T> {
  return "query" in client
    ? read(client.query, client.fragments)
    : patternSession(client).run((sql) => read(sql, sql));
}
export function patternSession(parent: Sql): BoundedPgSession {
  let session = sessions.get(parent);
  if (!session) {
    session = new BoundedPgSession(parent, {
      deadlineMs: 3000,
      maxPending: 32,
      idleTimeoutMs: 1000,
    });
    sessions.set(parent, session);
  }
  return session;
}
export function patternOwner(sql: PatternSql, scope: PatternScope) {
  return sql`select id from noelle.agent_instances
    where id=${scope.agentInstanceId} and org_id=${scope.orgId} and role=${scope.role}
      ${
        scope.userId
          ? sql`and exists(select 1 from noelle.org_members m
        where m.org_id=${scope.orgId} and m.user_id=${scope.userId})`
          : sql``
      }`;
}
/** Parent and optional current membership remain locked until the scoped SQL operation commits. */
export async function lockPatternOwner(tx: TransactionSql, scope: PatternScope): Promise<boolean> {
  await tx`set local lock_timeout='1s'`;
  await tx`set local statement_timeout='2s'`;
  await tx`set local idle_in_transaction_session_timeout='3s'`;
  const rows = await tx`${patternOwner(tx, scope)} for no key update`;
  if (!rows.length) return false;
  if (scope.userId) {
    const member = await tx`select user_id from noelle.org_members
      where org_id=${scope.orgId} and user_id=${scope.userId} for share`;
    if (!member.length) return false;
  }
  return true;
}
