"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { OrgMembershipError } from "@noelle/runtime";
import { getOrgBySlug } from "@/lib/queries";
import { setGuidedDismissed } from "@/lib/guided/dismissal";

const Input = z.object({
  orgSlug: z.string().min(1),
  dismissed: z.boolean(),
});

export type DismissResult = { ok: true } | { ok: false; error: string };

/**
 * Hide (or restore) the guided setup panel for this operator.
 *
 * `getOrgBySlug` asserts org membership internally, so an attacker cannot flip
 * the flag for an org they do not belong to — even though the flag itself lives
 * in their own cookie, resolving the slug is still a tenant read.
 */
export async function setGuidedSetupDismissed(input: {
  orgSlug: string;
  dismissed: boolean;
}): Promise<DismissResult> {
  const parsed = Input.safeParse(input);
  if (!parsed.success) return { ok: false, error: "invalid_input" };

  try {
    const org = await getOrgBySlug(parsed.data.orgSlug);
    if (!org) return { ok: false, error: "not_found" };
  } catch (err) {
    if (err instanceof OrgMembershipError) return { ok: false, error: "forbidden" };
    throw err;
  }

  await setGuidedDismissed(parsed.data.orgSlug, parsed.data.dismissed);
  revalidatePath(`/app/${parsed.data.orgSlug}`);
  revalidatePath(`/app/${parsed.data.orgSlug}/onboarding`);
  return { ok: true };
}
