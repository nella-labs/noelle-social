/**
 * POST /api/vault/upload — issue a signed GCS PUT URL the browser can
 * upload a vault file to directly.
 *
 * Body shape (Zod-validated):
 *   { orgId: uuid, filename: string, contentType: string }
 *
 * Auth: the user must be a member of `orgId`. We do not trust the
 * filename — `signUpload` blocks `..`, leading `/`, and NUL bytes so a
 * crafted name can't escape the tenant's GCS prefix (the only isolation
 * boundary between tenants in the bucket).
 *
 * The upload itself happens browser → GCS directly with the returned URL.
 * Retrieval reads straight from the GCS prefix (the BM25 shim,
 * `NOELLE_NELLA_BACKEND=gcs`), so a new object is searchable within the
 * shim's cache window — no Nella reindex hook needed (that path is dormant).
 *
 * Runtime: Node.js Serverless. We need GCS service-account creds (loaded
 * via the Vercel WIF flow used by `apps/app/src/lib/db.ts`); Edge can't
 * carry those.
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { createVaultStorage, createGcsStorage } from "@noelle/runtime/vault-storage";
import { assertOrgMember, OrgMembershipError } from "@noelle/runtime";
import { pgOrgMembersClient, sql } from "@/lib/db";
import { getUserFromCookies } from "@/lib/auth-cookie";

export const runtime = "nodejs";

const BodySchema = z.object({
  orgId: z.string().uuid(),
  filename: z
    .string()
    .min(1)
    .max(512)
    .refine((v) => !v.includes("..") && !v.startsWith("/") && !v.includes("\0"), {
      message: "path traversal blocked",
    }),
  contentType: z.string().min(1).max(128),
});

export async function POST(req: Request) {
  const user = await getUserFromCookies();
  if (!user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const body = await req.json().catch(() => null);
  const parsed = BodySchema.safeParse(body);
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

  const rows = await sql<{ storage_bucket: string; storage_prefix: string; status: string }[]>`
    select storage_bucket, storage_prefix, status
    from noelle.vaults
    where org_id = ${parsed.data.orgId}
    limit 1
  `;
  const vault = rows[0];
  if (!vault) {
    return NextResponse.json(
      { error: "no_vault", hint: "provision a vault for this org first" },
      { status: 409 },
    );
  }
  if (vault.status !== "active" && vault.status !== "provisioning") {
    return NextResponse.json(
      { error: "vault_inactive", status: vault.status },
      { status: 409 },
    );
  }

  const storage = createVaultStorage(await createGcsStorage());
  try {
    const url = await storage.signUpload({
      bucket: vault.storage_bucket,
      prefix: vault.storage_prefix,
      filename: parsed.data.filename,
      contentType: parsed.data.contentType,
    });
    return NextResponse.json({ url, expiresInSeconds: 600 });
  } catch (err) {
    if (err instanceof Error && /path traversal/i.test(err.message)) {
      return NextResponse.json({ error: "bad_filename" }, { status: 400 });
    }
    throw err;
  }
}
