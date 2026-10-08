/**
 * POST /api/vault/import — bulk-write markdown files into an org's vault.
 *
 * Body shape (Zod-validated):
 *   {
 *     orgId: uuid,
 *     files: Array<{ path: string; body: string }>,
 *     markStage?: "light" | "medium" | "rich",
 *   }
 *
 * The client (`ImportStep`) reads a user-selected folder or batch of
 * `.md` files in the browser and sends them here in chunks. We provision
 * the vault if missing, write each file straight to GCS via
 * `vaultStorage.writeText`, and (optionally) advance `wizard_stage` so
 * the soft-gate banner disappears once the user has imported real
 * content. Nella's existing sync job indexes the new objects on its
 * normal cadence — no extra hook needed.
 *
 * Tenancy: every file path is concatenated to the org's prefix; the
 * underlying `signUpload`/`writeText` helpers reject `..`, leading `/`,
 * and NUL bytes, which is the only thing keeping a malicious caller out
 * of another tenant's prefix (per-prefix IAM is out of scope for 0.0.1).
 *
 * Runtime: Node.js Serverless — needs GCS creds via Vercel WIF.
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import {
  assertOrgMember,
  OrgMembershipError,
  provisionVaultForOrg,
} from "@noelle/runtime";
import {
  createGcsStorage,
  createVaultStorage,
} from "@noelle/runtime/vault-storage";
import { pgOrgMembersClient, sql } from "@/lib/db";
import { getUserFromCookies } from "@/lib/auth-cookie";
import { getOrgBySlug } from "@/lib/queries";

export const runtime = "nodejs";

const MAX_FILES_PER_REQUEST = 100;
const MAX_BYTES_PER_FILE = 512 * 1024; // 512 KiB; markdown rarely exceeds this
const MAX_TOTAL_BYTES = 8 * 1024 * 1024; // soft cap per request; client batches above this

const FileSchema = z.object({
  path: z
    .string()
    .min(1)
    .max(512)
    .refine((v) => !v.includes("..") && !v.startsWith("/") && !v.includes("\0"), {
      message: "path traversal blocked",
    })
    .refine((v) => v.toLowerCase().endsWith(".md"), {
      message: "only .md files are accepted",
    }),
  body: z.string().max(MAX_BYTES_PER_FILE),
});

const BodySchema = z.object({
  orgId: z.string().uuid(),
  orgSlug: z.string().min(1).max(64),
  files: z.array(FileSchema).min(1).max(MAX_FILES_PER_REQUEST),
  markStage: z.enum(["light", "medium", "rich"]).optional(),
});

export async function POST(req: Request) {
  const user = await getUserFromCookies();
  if (!user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const raw = await req.json().catch(() => null);
  const parsed = BodySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "bad_request", issues: parsed.error.flatten() },
      { status: 400 },
    );
  }

  // Total-bytes guard. Zod can't enforce sum-over-array, so re-check here.
  const totalBytes = parsed.data.files.reduce((n, f) => n + f.body.length, 0);
  if (totalBytes > MAX_TOTAL_BYTES) {
    return NextResponse.json(
      { error: "payload_too_large", totalBytes, max: MAX_TOTAL_BYTES },
      { status: 413 },
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

  // Verify slug → id agrees with the one the client sent. The client
  // already knows the slug from the URL; we re-look it up so a tampered
  // body can't bind one tenant's id to another tenant's slug (and thus
  // write into the wrong GCS prefix).
  const org = await getOrgBySlug(parsed.data.orgSlug);
  if (!org || org.id !== parsed.data.orgId) {
    return NextResponse.json({ error: "org_mismatch" }, { status: 400 });
  }

  const vault = await provisionVaultForOrg({
    db: ((text: string, params: unknown[]) =>
      (sql as unknown as { unsafe: (t: string, p: unknown[]) => Promise<unknown> }).unsafe(
        text,
        params,
      )) as never,
    orgId: parsed.data.orgId,
    orgSlug: org.slug,
  });

  const storage = createVaultStorage(await createGcsStorage());
  const written: string[] = [];
  for (const file of parsed.data.files) {
    try {
      await storage.writeText({
        bucket: vault.storage_bucket,
        prefix: vault.storage_prefix,
        filename: file.path,
        body: file.body,
      });
      written.push(file.path);
    } catch (err) {
      if (err instanceof Error && /path traversal/i.test(err.message)) {
        return NextResponse.json(
          { error: "bad_filename", path: file.path, written },
          { status: 400 },
        );
      }
      throw err;
    }
  }

  if (parsed.data.markStage) {
    await sql`
      update noelle.vaults
         set wizard_stage = ${parsed.data.markStage}
       where org_id = ${parsed.data.orgId}
    `;
  }

  return NextResponse.json({ written, count: written.length });
}
