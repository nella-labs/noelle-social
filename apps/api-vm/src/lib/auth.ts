import {
  assertOrgMember as sharedAssertOrgMember,
  isOrgMember as sharedIsOrgMember,
  OrgMembershipError,
  type QueryExecutor,
} from "@noelle/runtime";
import { noelleDb } from "./db.js";
import type { Sql, TransactionSql } from "postgres";

// JWT verification still lives in src/middleware/jwt.ts — this module is the
// post-auth helpers that the route handlers reach for after the user is
// identified. Phase 4 of the Supabase → GCP migration replaced the
// Supabase service-role client with a direct Cloud SQL connection; the
// helper names + signatures are preserved so the route handlers don't need
// to change shape.
//
// Re-export the shared error class so route handlers can `catch` against it
// without reaching across the workspace.
export { OrgMembershipError };

/**
 * Adapter that turns the postgres.js singleton into a `QueryExecutor` — the
 * driver-agnostic shape the shared tenancy guards consume. postgres.js
 * exposes an `.unsafe(query, params)` method for parametrised raw SQL,
 * which is what we need here (the membership query is fixed).
 */
function executor(): QueryExecutor {
  const sql = noelleDb();
  return async (query, params) => {
    // postgres.js's unsafe() takes ParameterOrJSON<T>[]; our values come
    // through as `unknown[]` from the QueryExecutor signature. The cast is
    // safe because the call sites in tenancy.ts only ever pass primitives
    // (strings, in the org-membership check).
    const rows = await sql.unsafe(query, params as never[]);
    return rows as unknown as ReadonlyArray<Record<string, unknown>>;
  };
}

// ---------------------------------------------------------------------------
// Authz helpers — confirm a Supabase auth user belongs to the org that owns
// the row being read/written. Cloud SQL doesn't run RLS for `noelle.*`, so
// the handler does this check by hand.
// ---------------------------------------------------------------------------
export async function isOrgMember(
  userId: string,
  orgId: string,
): Promise<boolean> {
  return sharedIsOrgMember(executor(), userId, orgId);
}

export async function assertOrgMember(
  userId: string,
  orgId: string,
): Promise<void> {
  return sharedAssertOrgMember(executor(), userId, orgId);
}

// ---------------------------------------------------------------------------
// Single-tenant helper (0.0.1): resolve the one active x_intern instance.
// In 0.1.0 we'll route per-drafter-HMAC-key; for now there's exactly one row.
// ---------------------------------------------------------------------------
export async function resolveActiveXInternInstance(): Promise<
  { org_id: string; agent_instance_id: string } | null
> {
  const sql = noelleDb();
  const rows = await sql<
    Array<{ id: string; org_id: string }>
  >`
    select id, org_id
    from noelle.agent_instances
    where role = 'x_intern' and status = 'active'
    limit 1
  `;
  const row = rows[0];
  if (!row) return null;
  return { org_id: row.org_id, agent_instance_id: row.id };
}

// Platform → agent role. Outbound resolves the owning instance by the payload's
// platform so the LinkedIn intern (Lyra) gets LinkedIn drafts and the X intern
// gets X drafts (single active instance per role in 0.0.1).
const PLATFORM_ROLE: Record<string, string> = {
  x: "x_intern",
  linkedin: "linkedin_intern",
  reddit: "reddit_intern",
};

export class AmbiguousOutboundOwnerError extends Error {
  constructor() { super("Outbound without an explicit owner requires one eligible instance."); }
}

export async function resolveActiveInstanceForPlatform(
  platform: string,
  owner?: { orgId: string; agentInstanceId: string },
  selection?: { sql: Sql | TransactionSql; lock?: true },
): Promise<{ org_id: string; agent_instance_id: string; role: string } | null> {
  // Fail loud on an unmapped platform rather than silently defaulting to
  // x_intern. The old `?? "x_intern"` fallback meant a platform missing from
  // PLATFORM_ROLE (reddit, before it was added) routed EVERY draft onto Vega's
  // instance — polluting the X intern's approval queue with another intern's
  // leads. A null here surfaces as a clean "no_active_instance" error instead.
  const role = PLATFORM_ROLE[platform];
  if (!role) return null;
  const sql = selection?.sql ?? noelleDb();
  // Accept active OR paused instances: the always-on watchlist lane drafts
  // replies/DMs to watched people even while the keyword pipeline is paused, so
  // outbound must still resolve the (single, 0.0.1) instance to save them.
  // Prefer 'active' when both somehow exist.
  const rows = await sql<Array<{ id: string; org_id: string }>>`
    select id, org_id
    from noelle.agent_instances
    where role = ${role} and status in ('active', 'paused')
      and (${owner?.orgId ?? null}::uuid is null or org_id = ${owner?.orgId ?? null})
      and (${owner?.agentInstanceId ?? null}::uuid is null or id = ${owner?.agentInstanceId ?? null})
    order by (status = 'active') desc
    limit ${selection ? 2 : 1}
    ${selection?.lock ? sql`for no key update` : sql``}
  `;
  if (selection && rows.length > 1) throw new AmbiguousOutboundOwnerError();
  const row = rows[0];
  if (!row) return null;
  return { org_id: row.org_id, agent_instance_id: row.id, role };
}
