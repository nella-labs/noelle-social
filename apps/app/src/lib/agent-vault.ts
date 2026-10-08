"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { OrgMembershipError } from "@noelle/runtime";
import { BoundedPgSession } from "@noelle/runtime/bounded-pg-session";
import { sql } from "@/lib/db";
import { getCurrentUser, getOrgBySlug } from "@/lib/queries";
import { vaultRootIdentity, writeVaultFile } from "@/lib/vault-fs";
import { resolveLocalVaultRootForOrg } from "@/lib/vault";
import { parseStoredVaultEdit } from "@/lib/agent-chat/proposal";

const ApplyVaultEditInput = z.object({
  orgSlug: z.string().min(1), instanceId: z.string().uuid(), messageId: z.string().uuid(),
});
const writers = new WeakMap<typeof sql, BoundedPgSession>();
function writer(): BoundedPgSession {
  let owner = writers.get(sql);
  if (!owner) {
    owner = new BoundedPgSession(sql, { deadlineMs: 10_000, maxPending: 32, idleTimeoutMs: 1_000 });
    writers.set(sql, owner);
  }
  return owner;
}
export type ApplyVaultEditResult =
  | { ok: true; path: string }
  | { ok: false; error: string };

/** Apply the durable server proposal under a scoped, cooperative file-write lease. */
export async function applyVaultEdit(input: z.infer<typeof ApplyVaultEditInput>): Promise<ApplyVaultEditResult> {
  const parsed = ApplyVaultEditInput.safeParse(input);
  if (!parsed.success) return { ok: false, error: "invalid" };
  const { orgSlug, instanceId, messageId } = parsed.data;
  const user = await getCurrentUser();
  if (!user) return { ok: false, error: "unauthenticated" };
  let orgId: string;
  try {
    const org = await getOrgBySlug(orgSlug);
    if (!org) return { ok: false, error: "not_found" };
    orgId = org.id;
  } catch (error) {
    if (error instanceof OrgMembershipError) return { ok: false, error: "forbidden" };
    throw error;
  }
  const root = await resolveLocalVaultRootForOrg(orgId);
  if (!root) return { ok: false, error: "no_vault" };
  const rootIdentity = await vaultRootIdentity(root);
  let renameAdmitted = false;
  try {
    const result = await writer().runLease(async (tx) => {
      await tx`select pg_advisory_xact_lock(hashtextextended(${rootIdentity}, 0))`;
      const [row] = await tx<{ vault_edit: unknown; agent_role: string }[]>`
        select c.vault_edit, i.role as agent_role
        from noelle.agent_chat_messages c
        join noelle.agent_instances i on i.id = c.agent_instance_id and i.org_id = c.org_id
        join noelle.organizations o on o.id = i.org_id
        join noelle.org_members m on m.org_id = o.id and m.user_id = c.user_id
        where c.id = ${messageId} and c.org_id = ${orgId} and o.slug = ${orgSlug}
          and c.agent_instance_id = ${instanceId} and c.user_id = ${user.id} and c.role = 'agent'
        for share of c, i, o, m
      `;
      const stored = row ? parseStoredVaultEdit(row.vault_edit) : null;
      if (!row || !stored) return { error: "not_found" } as const;
      if (!stored.basis || stored.refreshReason || stored.agentRole !== row.agent_role) return { error: "refresh_required" } as const;
      return { stored } as const;
    }, async (prepared, lease): Promise<ApplyVaultEditResult> => {
      if ("error" in prepared) return { ok: false, error: prepared.error ?? "unavailable" };
      const { stored } = prepared;
      const res = await writeVaultFile(root, stored.proposal.path, stored.proposal.content, {
        basis: stored.basis!, signal: lease.signal, assertActive: lease.assertActive,
        rootStillBound: async () => {
          const current = await resolveLocalVaultRootForOrg(orgId);
          return current !== null && await vaultRootIdentity(current) === rootIdentity;
        },
        onRenameAdmitted: () => { renameAdmitted = true; },
      });
      return res.ok ? { ok: true, path: stored.proposal.path } : res;
    });
    if (!result.ok) return renameAdmitted ? { ok: false, error: "uncertain" } : result;
    revalidatePath("/app/[orgSlug]/agents/[instanceId]", "page");
    return result;
  } catch {
    return { ok: false, error: renameAdmitted ? "uncertain" : "unavailable" };
  }
}
