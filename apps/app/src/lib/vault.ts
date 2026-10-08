/**
 * Vault read helpers — Cloud SQL queries gated by `assertOrgMember`.
 *
 * Every metadata reader:
 *   1. Resolves the signed-in user from the Supabase cookie.
 *   2. Asserts they are a member of the org via `assertOrgMember`.
 *   3. Reads from `noelle.vaults` / `noelle.vault_anchor_usage`.
 *
 * No RLS in Cloud SQL — the membership check above is the only thing
 * keeping a user from reading another tenant's vault metadata by guessing
 * the org id. Skipping it is a tenancy leak.
 *
 * The dashboard vault page (`apps/app/src/app/app/[orgSlug]/vault/page.tsx`)
 * consumes these helpers. Anchor usage rows are written by the agent
 * worker pool (out of scope for this module); we only read here.
 */

import { assertOrgMember } from "@noelle/runtime";
import {
  createVaultStorage,
  createGcsStorage,
  assertSafeVaultPrefix,
  VAULT_LIST_DEFAULT_LIMIT,
  VAULT_LIST_PAGE_LIMIT,
  VAULT_LIST_PAGE_TOKEN_LIMIT,
  type VaultFileMeta,
} from "@noelle/runtime/vault-storage";
import { pgOrgMembersClient, sql } from "@/lib/db";
import { getUserFromCookies } from "@/lib/auth-cookie";
import { listVaultFileMeta, resolveVaultRoot, vaultRoot, VAULT_LOCAL_SCAN_FILE_LIMIT } from "@/lib/vault-fs";
import { isLocalAuth, localOrgSlug } from "@/lib/local-auth";
import type {
  NoelleVault,
  NoelleVaultAnchorUsage,
  NoelleVaultWizardAnswers,
} from "@/lib/db-types";

export class VaultListingError extends Error {
  constructor(readonly code: "unauthorized" | "invalid_page") {
    super(code === "unauthorized" ? "not signed in" : "This listing page is no longer available. Start from the first page.");
    this.name = "VaultListingError";
  }
}

async function requireUserId(): Promise<string> {
  const user = await getUserFromCookies();
  if (!user) throw new VaultListingError("unauthorized");
  return user.id;
}

/** A configured local root belongs only to its configured organization. */
export async function resolveLocalVaultRootForOrg(orgId: string): Promise<string | null> {
  const root = vaultRoot();
  if (!root) return null;
  const explicitSlug = process.env.NOELLE_LOCAL_ORG_SLUG?.trim();
  const slug = explicitSlug || (isLocalAuth() ? localOrgSlug().trim() : null);
  if (!slug) return null;
  const [org] = await sql<{ id: string }[]>`
    select id from noelle.organizations where id = ${orgId} and slug = ${slug} limit 1
  `;
  return org ? resolveVaultRoot(root) : null;
}

/**
 * Return the vault row for an org, or null when no vault has been
 * provisioned yet. Used by the dashboard vault page to decide between the
 * live view and the empty-state CTA.
 */
export async function getVaultForOrg(orgId: string): Promise<NoelleVault | null> {
  const userId = await requireUserId();
  await assertOrgMember(pgOrgMembersClient(), userId, orgId);
  const rows = await sql<NoelleVault[]>`
    select * from noelle.vaults where org_id = ${orgId} limit 1
  `;
  return rows[0] ?? null;
}

type VaultListingSource = "local" | "cloud";
type VaultPageFields = { files: VaultFileMeta[]; nextPageToken: string | null; partial: boolean };
export type VaultListingPage = VaultPageFields & (
  { status: "ready"; source: VaultListingSource } |
  { status: "unprovisioned"; source: null } |
  { status: "unavailable"; source: VaultListingSource; message: string }
);

function listingCursor(token: string | undefined): { source: VaultListingSource; value: string } | null {
  if (token === undefined) return null;
  if (typeof token !== "string" || token.length > "cloud1:".length + VAULT_LIST_PAGE_TOKEN_LIMIT) throw new VaultListingError("invalid_page");
  if (token.startsWith("local1:")) {
    const value = token.slice("local1:".length);
    if (!/^(0|[1-9]\d*)$/.test(value) || Number(value) > VAULT_LOCAL_SCAN_FILE_LIMIT) throw new VaultListingError("invalid_page");
    return { source: "local", value };
  }
  if (token.startsWith("cloud1:") && token.length > "cloud1:".length) return { source: "cloud", value: token.slice("cloud1:".length) };
  throw new VaultListingError("invalid_page");
}

/** One scoped metadata page. Local continuations repeat a bounded current scan. */
export async function listVaultFilesForOrg(
  orgId: string,
  options: { pageToken?: string; limit?: number } = {},
): Promise<VaultListingPage> {
  const userId = await requireUserId();
  await assertOrgMember(pgOrgMembersClient(), userId, orgId);
  const limit = options.limit ?? VAULT_LIST_DEFAULT_LIMIT;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > VAULT_LIST_PAGE_LIMIT) throw new VaultListingError("invalid_page");
  const cursor = listingCursor(options.pageToken);
  const rows = await sql<{ storage_bucket: string; storage_prefix: string }[]>`
    select storage_bucket, storage_prefix from noelle.vaults where org_id = ${orgId} limit 1
  `;
  const vault = rows[0];
  const empty: VaultPageFields = { files: [], nextPageToken: null, partial: false };
  if (!vault) return { ...empty, status: "unprovisioned", source: null };
  const root = await resolveLocalVaultRootForOrg(orgId);
  const source = root ? "local" : "cloud";
  if (cursor && cursor.source !== source) throw new VaultListingError("invalid_page");
  try {
    assertSafeVaultPrefix(vault.storage_prefix);
    if (root) {
      const page = await listVaultFileMeta(root, { limit, offset: cursor ? Number(cursor.value) : 0 });
      return {
        status: "ready", source, partial: page.partial,
        files: page.files.map((m) => ({ path: `${vault.storage_prefix}${m.rel}`, size: m.size, updatedISO: m.updatedISO })),
        nextPageToken: page.nextOffset === null ? null : `local1:${page.nextOffset}`,
      };
    }
    const storage = createVaultStorage(await createGcsStorage());
    const page = await storage.listPage({ bucket: vault.storage_bucket, prefix: vault.storage_prefix, limit,
      ...(cursor === null ? {} : { pageToken: cursor.value }) });
    return { status: "ready", source, partial: false, files: page.files,
      nextPageToken: page.nextPageToken === null ? null : `cloud1:${page.nextPageToken}` };
  } catch {
    return { ...empty, status: "unavailable", source, message: "Could not load this vault listing. Try again." };
  }
}

/**
 * Recent anchor usage for an org, newest first. Default cap of 20 matches
 * what the dashboard renders in the "Anchors used today" card.
 */
export async function listAnchorUsageForOrg(
  orgId: string,
  limit = 20,
): Promise<NoelleVaultAnchorUsage[]> {
  const userId = await requireUserId();
  await assertOrgMember(pgOrgMembersClient(), userId, orgId);
  return sql<NoelleVaultAnchorUsage[]>`
    select * from noelle.vault_anchor_usage
    where org_id = ${orgId}
    order by created_at desc
    limit ${limit}
  `;
}

/**
 * Return the vault wizard answers row for an org, or null if no wizard
 * progress has been saved yet. Used by the wizard router to resume from
 * the saved stage and answers.
 */
export async function getVaultWizardAnswersForOrg(
  orgId: string,
): Promise<NoelleVaultWizardAnswers | null> {
  const userId = await requireUserId();
  await assertOrgMember(pgOrgMembersClient(), userId, orgId);
  const rows = await sql<NoelleVaultWizardAnswers[]>`
    select org_id, stage_completed, answers, updated_at
    from noelle.vault_wizard_answers
    where org_id = ${orgId}
    limit 1
  `;
  return rows[0] ?? null;
}
