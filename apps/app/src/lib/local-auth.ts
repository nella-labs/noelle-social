/**
 * Single-user local-auth shim for self-hosted Noelle.
 *
 * On a self-host box there is no remote Supabase. Instead the `noelle` CLI
 * mints a long-lived operator JWT (HS256, signed with the local
 * NOELLE_SUPABASE_JWT_SECRET) and sets NOELLE_AUTH_MODE=local. When that flag
 * is on, the dashboard short-circuits every Supabase-coupled entry point to a
 * single fixed operator identity; api-vm still verifies the minted JWT with
 * its existing HS256 path, so the trust boundary (assertOrgMember on the seeded
 * org) is unchanged.
 *
 * EDGE-SAFE: this module is imported by `middleware.ts` (Edge runtime). It must
 * not import `next/headers`, `postgres`, `node:crypto`, or anything Node-only.
 * It only reads `process.env`. The Node-only minting/seeding lives in the CLI.
 */

import type { CookieUser } from "./auth-cookie";

const DEFAULT_OPERATOR_SUB = "00000000-0000-4000-8000-000000000001";
const DEFAULT_OPERATOR_EMAIL = "operator@example.com";

export function isLocalAuth(): boolean {
  return process.env.NOELLE_AUTH_MODE === "local";
}

export function localOperatorSub(): string {
  return process.env.NOELLE_LOCAL_OPERATOR_SUB || DEFAULT_OPERATOR_SUB;
}

export function localOperatorEmail(): string {
  return process.env.NOELLE_LOCAL_OPERATOR_EMAIL || DEFAULT_OPERATOR_EMAIL;
}

/** Workspace slug seeded by the local CLI. */
export function localOrgSlug(): string {
  return process.env.NOELLE_LOCAL_ORG_SLUG || "workspace";
}

/** The fixed operator identity, in the shape `getUserFromCookies()` returns. */
export function localOperator(): CookieUser {
  return {
    id: localOperatorSub(),
    email: localOperatorEmail(),
    user_metadata: {
      full_name: process.env.NOELLE_LOCAL_OPERATOR_NAME || "Operator",
    },
    app_metadata: { provider: "local" },
  };
}

/** The minted operator JWT the dashboard forwards to api-vm (Bearer). */
export function localOperatorJwt(): string | null {
  return process.env.NOELLE_LOCAL_OPERATOR_JWT || null;
}
