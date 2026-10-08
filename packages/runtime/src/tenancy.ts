/**
 * Tenancy guards — Phase 2 + Phase 4 of the Supabase → GCP migration
 * (see tasks/supabase-to-gcp-migration.md).
 *
 * `noelle.*` lives in Cloud SQL Postgres. `auth.uid()` is gone; RLS is gone.
 * Every read/write of `noelle.*` must prove (in TS) that the caller is a
 * member of the row's org BEFORE touching the data. This module is the
 * single home for that check.
 *
 * Two backend shapes share this guard:
 *
 *   1. `apps/api-vm` connects directly to Cloud SQL via the `postgres`
 *      (postgres.js) tagged-template client. We model this as a
 *      `QueryExecutor` — a single async function `(sql, params) => rows`.
 *
 *   2. `apps/app` (Next.js, on Vercel) still talks to Supabase JS for the
 *      cookie-bound session. Until that side is also cut over, we keep the
 *      original `OrgMembersQueryClient` shape working unchanged so the
 *      apps/app server actions don't have to migrate in lockstep.
 *
 * `assertOrgMember` / `isOrgMember` accept either shape. We discriminate at
 * runtime: if the first arg is a function, we treat it as a `QueryExecutor`;
 * otherwise we use the Supabase chain.
 *
 * Keeping this package free of `@supabase/supabase-js` and `postgres` keeps
 * `@noelle/runtime` portable and zero-dep beyond zod.
 */

/**
 * Minimal structural type for the Supabase JS query builder shape used by
 * `apps/app`. Intentionally loose so we don't pin to a specific generated
 * `Database` type.
 */
export interface OrgMembersQueryClient {
  from(table: "org_members"): {
    select(columns: string): {
      eq(
        column: "org_id" | "user_id",
        value: string,
      ): {
        eq(
          column: "org_id" | "user_id",
          value: string,
        ): {
          maybeSingle(): Promise<{
            data: { user_id: string } | null;
            error: { message: string } | null;
          }>;
        };
      };
    };
  };
}

/**
 * Direct-Postgres executor. A single async function that takes a parametrised
 * SQL string + bind values and returns rows. Both `pg` (node-postgres) and
 * `postgres` (postgres.js) can satisfy this with a 3-line adapter; see
 * `apps/api-vm/src/lib/auth.ts` for the postgres.js binding.
 *
 * The shape is intentionally driver-agnostic so `apps/app` can adopt the
 * same executor when it moves off Supabase JS, and so tests can stub it
 * with a vanilla function.
 */
export type QueryExecutor = (
  sql: string,
  params: ReadonlyArray<unknown>,
) => Promise<ReadonlyArray<Record<string, unknown>>>;

/**
 * Thrown by `assertOrgMember` when the caller is not a member of the org.
 */
export class OrgMembershipError extends Error {
  readonly code = "not_org_member" as const;
  readonly userId: string;
  readonly orgId: string;
  constructor(userId: string, orgId: string) {
    super(`user ${userId} is not a member of org ${orgId}`);
    this.name = "OrgMembershipError";
    this.userId = userId;
    this.orgId = orgId;
  }
}

function isQueryExecutor(
  client: OrgMembersQueryClient | QueryExecutor,
): client is QueryExecutor {
  return typeof client === "function";
}

/**
 * Non-throwing membership check. Returns `true` iff a row exists in
 * `noelle.org_members` for (orgId, userId). Any query error returns `false`
 * — we fail closed.
 *
 * Accepts either a Supabase-shaped `OrgMembersQueryClient` (apps/app) or a
 * direct-Postgres `QueryExecutor` (apps/api-vm).
 */
export async function isOrgMember(
  client: OrgMembersQueryClient | QueryExecutor,
  userId: string,
  orgId: string,
): Promise<boolean> {
  if (isQueryExecutor(client)) {
    try {
      const rows = await client(
        // Schema-qualified so the executor doesn't have to set a search_path.
        // LIMIT 1 keeps the planner honest even though (org_id, user_id) is
        // the PK and is already unique.
        `select user_id from noelle.org_members where org_id = $1 and user_id = $2 limit 1`,
        [orgId, userId],
      );
      return rows.length > 0;
    } catch {
      return false;
    }
  }

  const { data, error } = await client
    .from("org_members")
    .select("user_id")
    .eq("org_id", orgId)
    .eq("user_id", userId)
    .maybeSingle();
  if (error) return false;
  return data !== null;
}

/**
 * Throwing variant — call at the top of every server action / route handler
 * before touching `noelle.*` data on behalf of a signed-in user.
 */
export async function assertOrgMember(
  client: OrgMembersQueryClient | QueryExecutor,
  userId: string,
  orgId: string,
): Promise<void> {
  if (!(await isOrgMember(client, userId, orgId))) {
    throw new OrgMembershipError(userId, orgId);
  }
}
