/**
 * Vault provisioning — idempotent helper that ensures a `noelle.vaults`
 * row exists for an org. Used by the onboarding flow when a new tenant
 * lands, and exposed to maintenance scripts so an existing tenant can
 * also have a vault created retroactively.
 *
 * The Nella workspace itself is not created here yet — Nella's
 * workspace-create endpoint isn't exposed in 0.0.1 (see
 * docs/nella-contract.md §2). Until that's available, we insert the row
 * with `status = 'provisioning'`; an operator runs the Nella-side seed
 * by hand and flips the status to `active`. The agent vault resolver
 * treats anything other than `active` as "no vault" so workers don't
 * try to search a half-built workspace.
 *
 * GCS bucket / prefix are inserted with no side effect on the bucket —
 * GCS auto-creates objects on first PUT, so we don't need an explicit
 * mkdir step. The `<slug>/` prefix is per-tenant; this is the only
 * isolation between tenants in the bucket today.
 */

import type { QueryExecutor } from "./tenancy.js";

export interface ProvisionedVault {
  id: string;
  org_id: string;
  nella_workspace_id: string;
  storage_bucket: string;
  storage_prefix: string;
  status: string;
}

export async function provisionVaultForOrg(args: {
  db: QueryExecutor;
  orgId: string;
  orgSlug: string;
  bucket?: string;
}): Promise<ProvisionedVault> {
  const existing = (await args.db(
    `select id, org_id, nella_workspace_id, storage_bucket, storage_prefix, status
       from noelle.vaults where org_id = $1 limit 1`,
    [args.orgId],
  )) as unknown as ReadonlyArray<ProvisionedVault>;
  if (existing[0]) return existing[0];

  const bucket = args.bucket ?? "noelle-vaults";
  const prefix = `${args.orgSlug}/`;
  const workspace = `mars-${args.orgSlug}`;
  const inserted = (await args.db(
    `insert into noelle.vaults (org_id, nella_workspace_id, storage_bucket, storage_prefix, status)
     values ($1, $2, $3, $4, 'provisioning')
     on conflict (org_id) do update set
       nella_workspace_id = excluded.nella_workspace_id,
       storage_bucket     = excluded.storage_bucket,
       storage_prefix     = excluded.storage_prefix
     returning id, org_id, nella_workspace_id, storage_bucket, storage_prefix, status`,
    [args.orgId, workspace, bucket, prefix],
  )) as unknown as ReadonlyArray<ProvisionedVault>;
  if (!inserted[0]) throw new Error("vault insert returned no row");
  return inserted[0];
}
