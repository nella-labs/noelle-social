/**
 * GET /api/vault/file?orgId=...&path=... — return one vault file's body.
 *
 * Tenancy-gated exactly like the other vault routes. `path` is the
 * vault-relative path (no bucket prefix); the storage layer prepends the
 * org's prefix and re-validates against traversal.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { createVaultStorage, createGcsStorage, VaultSourceEncodingError } from "@noelle/runtime/vault-storage";
import { HttpBodyError } from "@noelle/runtime/bounded-http";
import { GcsObjectHttpError } from "@noelle/runtime/gcs-objects";
import { assertOrgMember, OrgMembershipError } from "@noelle/runtime";
import { pgOrgMembersClient, sql } from "@/lib/db";
import { getUserFromCookies } from "@/lib/auth-cookie";
import { readVaultSource, VAULT_PREVIEW_MAX_BYTES } from "@/lib/vault-fs";
import { resolveLocalVaultRootForOrg } from "@/lib/vault";

export const runtime = "nodejs";

const previewErrors = {
  too_large: { status: 413, message: "This file is too large to preview. Open it in your vault editor." },
  invalid_encoding: { status: 422, message: "This file is not valid UTF-8 text." },
  not_found: { status: 404 },
  unavailable: { status: 503, message: "This file is unavailable. Try again." },
  changed: { status: 409, message: "This file changed. Try again." },
} as const;
function previewError(error: keyof typeof previewErrors) {
  const { status, ...detail } = previewErrors[error];
  return NextResponse.json({ error, ...detail }, { status });
}

const QuerySchema = z.object({
  orgId: z.string().uuid(),
  path: z
    .string()
    .min(1)
    .max(512)
    .refine((v) => !v.includes("..") && !v.startsWith("/") && !v.includes("\0"), {
      message: "path traversal blocked",
    }),
});

export async function GET(req: Request) {
  const user = await getUserFromCookies();
  if (!user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const url = new URL(req.url);
  const parsed = QuerySchema.safeParse({
    orgId: url.searchParams.get("orgId"),
    path: url.searchParams.get("path"),
  });
  if (!parsed.success) {
    return NextResponse.json(
      { error: "bad_request", issues: parsed.error.flatten() },
      { status: 400 },
    );
  }

  try {
    await assertOrgMember(pgOrgMembersClient(), user.id, parsed.data.orgId);
  } catch (err) {
    if (err instanceof OrgMembershipError) {
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }
    throw err;
  }

  const rows = await sql<{ storage_bucket: string; storage_prefix: string }[]>`
    select storage_bucket, storage_prefix from noelle.vaults where org_id = ${parsed.data.orgId} limit 1
  `;
  const vault = rows[0];
  if (!vault) {
    return NextResponse.json({ error: "no_vault" }, { status: 404 });
  }

  // Local previews use the same organization-bound root as the file listing.
  const root = await resolveLocalVaultRootForOrg(parsed.data.orgId);
  if (root) {
    const source = await readVaultSource(root, parsed.data.path, { maxBytes: VAULT_PREVIEW_MAX_BYTES });
    if (source.kind === "too_large") {
      return previewError("too_large");
    }
    if (source.kind === "invalid_encoding") {
      return previewError("invalid_encoding");
    }
    if (source.kind === "unavailable" || source.kind === "changed") {
      return previewError(source.kind);
    }
    if (source.kind !== "file") {
      return previewError("not_found");
    }
    return NextResponse.json({ path: parsed.data.path, body: source.text });
  }

  try {
    const storage = createVaultStorage(await createGcsStorage());
    const body = await storage.readText({
      bucket: vault.storage_bucket,
      prefix: vault.storage_prefix,
      filename: parsed.data.path,
    });
    return NextResponse.json({ path: parsed.data.path, body });
  } catch (err) {
    if (err instanceof HttpBodyError && err.code === "body_too_large") {
      return previewError("too_large");
    }
    if (err instanceof VaultSourceEncodingError) {
      return previewError("invalid_encoding");
    }
    if (err instanceof GcsObjectHttpError && err.operation === "read" && err.status === 404) {
      return previewError("not_found");
    }
    if (err instanceof Error && /path traversal/i.test(err.message)) {
      return NextResponse.json({ error: "bad_path" }, { status: 400 });
    }
    return previewError("unavailable");
  }
}
