"use server";

/**
 * Infrastructure Server Actions (admin-only).
 *
 * `setLlmBackend` flips the GLOBAL agent-LLM backend for an org by writing
 * `noelle.organizations.llm_backend` ('aws' | 'claude'). The worker pool reads
 * this column within ~30s (no restart), so toggling it re-routes every agent
 * LLM call:
 *   - 'claude' -> the local `claude -p` Max-subscription path ($0, budget-exempt)
 *     on a VM where claude-cli is installed + logged in. On hosted prod (where
 *     the CLI isn't present) the workers fall back to Bedrock automatically.
 *   - 'aws'    -> per-token AWS Bedrock.
 *
 * Gated on `checkAdmin()` -- admin-only, NOT org-owner -- because this is an
 * operator/infra control, not a tenant setting. The org_id is resolved via
 * `getOrgBySlug`, which also runs the membership/IDOR check before returning
 * the row.
 */

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { OrgMembershipError } from "@noelle/runtime";
import { sql } from "@/lib/db";
import { checkAdmin } from "@/lib/admin-gate";
import { getOrgBySlug } from "@/lib/queries";

const Input = z.object({
  orgSlug: z.string().min(1),
  backend: z.enum(["aws", "claude"]),
});

export type SetLlmBackendInput = z.infer<typeof Input>;

export type SetLlmBackendResult =
  | { ok: true; backend: "aws" | "claude" }
  | { ok: false; error: { code: string; message: string } };

export async function setLlmBackend(input: SetLlmBackendInput): Promise<SetLlmBackendResult> {
  const parsed = Input.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: { code: "bad_input", message: parsed.error.message } };
  }
  const { orgSlug, backend } = parsed.data;

  const { isAdmin } = await checkAdmin();
  if (!isAdmin) {
    return { ok: false, error: { code: "forbidden", message: "Admin only." } };
  }

  let org;
  try {
    org = await getOrgBySlug(orgSlug);
  } catch (err) {
    if (err instanceof OrgMembershipError) {
      return { ok: false, error: { code: "forbidden", message: "Not a member of this org." } };
    }
    throw err;
  }
  if (!org) {
    return { ok: false, error: { code: "not_found", message: "Org not found." } };
  }

  try {
    await sql`
      update noelle.organizations
      set llm_backend = ${backend}
      where id = ${org.id}
    `;
  } catch (err) {
    return { ok: false, error: { code: "update_failed", message: (err as Error).message } };
  }

  revalidatePath(`/app/${orgSlug}/admin/infrastructure`);
  return { ok: true, backend };
}
