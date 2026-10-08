"use server";

import { revalidatePath } from "next/cache";
import { AgentRoleSchema } from "@noelle/contracts";
import { assertOrgMember } from "@noelle/runtime";
import { z } from "zod";
import { getUserFromCookies } from "@/lib/auth-cookie";
import { pgOrgMembersClient, sql } from "@/lib/db";

const HireInput = z.object({ orgSlug: z.string().min(1), role: AgentRoleSchema });
const DISPLAY_NAMES = { x_intern: "Vega", linkedin_intern: "Lyra", reddit_intern: "Orion", video_intern: "Nova" };

/** Enable a social channel without granting publication consent. */
export async function hireAgent(input: z.infer<typeof HireInput>) {
  const parsed = HireInput.parse(input);
  const user = await getUserFromCookies();
  if (!user) throw new Error("not signed in");
  const orgRows = await sql<{ id: string }[]>`
    select id from noelle.organizations where slug = ${parsed.orgSlug} limit 1
  `;
  const org = orgRows[0];
  if (!org) throw new Error("org not found");
  await assertOrgMember(pgOrgMembersClient(), user.id, org.id);

  await sql`
    insert into noelle.agent_instances
      (org_id, role, status, display_name, budget_cap_cents,
       classifier_enabled, send_enabled, auto_send_enabled, reply_send_enabled)
    values
      (${org.id}, ${parsed.role}, 'paused', ${DISPLAY_NAMES[parsed.role]}, 5000,
       ${parsed.role !== "linkedin_intern"}, false, false, false)
    on conflict (org_id, role) do update
      set status = 'paused', send_enabled = false, auto_send_enabled = false, reply_send_enabled = false
      where noelle.agent_instances.status = 'provisioning_alpha'
  `;
  revalidatePath(`/app/${parsed.orgSlug}`);
  revalidatePath(`/app/${parsed.orgSlug}/settings`);
}
