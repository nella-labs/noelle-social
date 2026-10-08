import { NoelleError, type NoelleContext } from "../context.js";

/** Called only by an explicit send action; never changes agent sending gates. */
export async function queueApprovedReply(
  ctx: NoelleContext,
  args: { orgId: string; approvalId: string; draftId: string; leadId: string | null; body?: string },
): Promise<void> {
  await ctx.sql.begin(async (tx) => {
    const updated = await tx`
      update noelle.approvals set auto_send_target_at = null
      where id = ${args.approvalId} and org_id = ${args.orgId} and status = 'pending'
      returning id`;
    if (!updated.length) throw new NoelleError("Approval is no longer pending; nothing was queued.");
    const edits = {
      human_send_approved: true,
      ...(args.body !== undefined ? { edited_body: args.body, edited: true } : {}),
    };
    await tx`
      update noelle.drafts set payload = coalesce(payload, '{}'::jsonb) || ${tx.json(edits)}
      where id = ${args.draftId} and org_id = ${args.orgId}`;
    await tx`
      update noelle.approvals a set status='skipped', decided_at=now(),
        decided_by=${ctx.operatorId()}, skip_reason='sibling-angle-approved'
      from noelle.drafts d
      where d.id=a.draft_id and a.lead_id=${args.leadId} and a.org_id=${args.orgId}
        and a.id<>${args.approvalId} and a.status='pending'
        and coalesce(d.payload->>'kind','reply')<>'dm'`;
  });
}
