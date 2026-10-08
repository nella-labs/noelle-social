"use server";

import {
  assertOrgMember,
  provisionVaultForOrg,
} from "@noelle/runtime";
import {
  createGcsStorage,
  createVaultStorage,
} from "@noelle/runtime/vault-storage";
import { renderVaultTemplate } from "@noelle/runtime/vault-template";
import {
  LightAnswersSchema,
  MediumAnswersSchema,
  RichAnswersSchema,
  UuidSchema,
  VaultWizardStageSchema,
  type VaultWizardStage,
} from "@noelle/contracts";
import { getUserFromCookies } from "@/lib/auth-cookie";
import { sql, pgOrgMembersClient, withTx } from "@/lib/db";
import { getOrgBySlug } from "@/lib/queries";
import { z } from "zod";

interface SubmitArgs {
  orgId: string;
  orgSlug: string;
  stage: VaultWizardStage;
  answers: Record<string, unknown>;
}

const SubmitInputSchema = z.object({
  orgId: UuidSchema,
  orgSlug: z.string().trim().min(1),
  stage: VaultWizardStageSchema,
  answers: z.record(z.unknown()),
});

type SubmitResult =
  | { ok: true; nextStep: "medium" | "rich" | "done" }
  | { ok: false; error: string; fieldErrors?: Record<string, string> };

/**
 * Server action for the general Mars vault onboarding wizard.
 *
 * Flow per stage:
 *   1. AuthN + tenant gate.
 *   2. Validate the stage's Zod schema.
 *   3. Merge with prior persisted answers (so Medium has Light's data).
 *   4. Provision the vault row (idempotent).
 *   5. Render the templated files for this stage.
 *   6. Write each file to GCS via vaultStorage.writeText.
 *   7. Upsert noelle.vault_wizard_answers, update noelle.vaults.wizard_stage.
 *
 */
export async function submitVaultStage(args: SubmitArgs): Promise<SubmitResult> {
  const user = await getUserFromCookies();
  if (!user) return { ok: false, error: "unauthorized" };
  const input = SubmitInputSchema.safeParse(args);
  if (!input.success) return { ok: false, error: "invalid_input" };
  args = input.data;

  let org: Awaited<ReturnType<typeof getOrgBySlug>>;
  try {
    await assertOrgMember(pgOrgMembersClient(), user.id, args.orgId);
    org = await getOrgBySlug(args.orgSlug);
  } catch {
    return { ok: false, error: "forbidden" };
  }
  if (!org || org.id.toLowerCase() !== args.orgId.toLowerCase()) return { ok: false, error: "not_found" };
  args = { ...args, orgId: org.id, orgSlug: org.slug };

  // Validate this stage's answers. For Medium/Rich we pick the new fields
  // only — prior fields are already persisted from earlier stages and are
  // merged below before rendering.
  const schema =
    args.stage === "light"
      ? LightAnswersSchema
      : args.stage === "medium"
        ? MediumAnswersSchema.pick({
            voiceDos: true,
            voiceDonts: true,
            bannedPhrases: true,
            contentPillars: true,
          })
        : RichAnswersSchema.pick({
            cadenceExamples: true,
            samplePosts: true,
          });
  const parsed = schema.safeParse(args.answers);
  if (!parsed.success) {
    const fieldErrors: Record<string, string> = {};
    for (const issue of parsed.error.issues) {
      const k = String(issue.path[0] ?? "_");
      fieldErrors[k] = issue.message;
    }
    return { ok: false, error: "invalid_answers", fieldErrors };
  }

  // Load prior answers and merge.
  const priorRows = await sql<{ answers: Record<string, unknown> }[]>`
    select answers from noelle.vault_wizard_answers where org_id = ${args.orgId} limit 1
  `;
  const prior = priorRows[0]?.answers ?? {};
  const merged = { ...prior, ...parsed.data };

  // Provision (idempotent). The vaultProvision helper takes a QueryExecutor
  // (text + params); bind `sql.unsafe` so postgres.js handles parametrisation.
  const vault = await provisionVaultForOrg({
    db: ((text: string, params: unknown[]) =>
      (sql as unknown as { unsafe: (t: string, p: unknown[]) => Promise<unknown> }).unsafe(
        text,
        params,
      )) as never,
    orgId: args.orgId,
    orgSlug: args.orgSlug,
  });

  // Render + write.
  const rendered = renderVaultTemplate({
    stage: args.stage,
    answers: merged,
    slug: args.orgSlug,
  });
  const storage = createVaultStorage(await createGcsStorage());
  for (const file of rendered) {
    await storage.writeText({
      bucket: vault.storage_bucket,
      prefix: vault.storage_prefix,
      filename: file.path,
      body: file.body,
    });
  }

  // Persist answers + stage together after all storage writes finish. tx.json
  // preserves an object as jsonb instead of double-encoding a JSON string.
  await withTx(async (tx) => {
    await tx`
      insert into noelle.vault_wizard_answers (org_id, stage_completed, answers)
      values (${args.orgId}, ${args.stage}, ${tx.json(merged)})
      on conflict (org_id) do update set
        stage_completed = excluded.stage_completed,
        answers         = excluded.answers
    `;
    const updated = await tx<{ id: string }[]>`
      update noelle.vaults set wizard_stage = ${args.stage} where id = ${vault.id} and org_id = ${args.orgId}
      returning id
    `;
    if (!updated[0]) throw new Error("Vault no longer available for setup");
  });

  const nextStep =
    args.stage === "light" ? "medium" : args.stage === "medium" ? "rich" : "done";
  return { ok: true, nextStep };
}
