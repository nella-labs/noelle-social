/**
 * Project flat `PendingApprovalRow`s into the client-side `SpeedrunDraft`
 * shape `<SpeedrunRow>` expects — grouped one card PER LEAD (3 reply angles +
 * the DM), not per draft.
 *
 * The mapping is intentionally lossy: speedrun only needs handle, source-post
 * preview, time-since-pushed, the angles, and the DM body. Anything not synced
 * (tier, follower count) becomes `null` and renders a neutral placeholder.
 */
import type { PendingApprovalRow } from "@/lib/queries";
import { bodyForSelectedAngle, draftPayload, leadPayload } from "@/lib/payload-shapes";
import { buildAnglesFromDrafts } from "@/lib/build-angles";
import { timeAgo } from "@/lib/utils";
import type { SpeedrunDraft } from "@/components/approvals/SpeedrunRow";
import { isXReplyReady } from "@/lib/reply-readiness";

/**
 * Group flat per-approval rows (3 reply angles + 1 DM per lead) into ONE
 * SpeedrunDraft per LEAD: the 3 angles (each carrying its own approvalId so
 * "mark sent" targets the picked angle) plus the DM body. This is what lets
 * speedrun show one boxed card per lead — pick a style, see the DM beside it —
 * numbered by lead instead of one numbered row per reply/DM across people.
 */
export function toSpeedrunLeads(
  rows: PendingApprovalRow[],
  /**
   * Lowercased X handles (no @) already on the intern's watchlist. Lets each
   * VIP banner render "On watchlist ✓" instead of "Add to watchlist" after a
   * reload. Defaults to an empty set (nothing watched) when not supplied.
   */
  watchedHandles: Set<string> = new Set(),
): SpeedrunDraft[] {
  // Preserve incoming order (score desc, then newest); first row per lead is
  // the representative for the header/source.
  const order: string[] = [];
  const byLead = new Map<string, PendingApprovalRow[]>();
  for (const r of rows) {
    const leadId = r.approval.lead_id ?? r.draft?.lead_id ?? r.approval.id;
    if (!byLead.has(leadId)) {
      byLead.set(leadId, []);
      order.push(leadId);
    }
    byLead.get(leadId)!.push(r);
  }

  const out: SpeedrunDraft[] = [];
  for (const leadId of order) {
    const sibs = byLead.get(leadId)!;
    const rep = sibs[0]!;
    const lp = leadPayload(rep.lead);
    const tier = rep.lead?.tier ?? lp.tier ?? null;
    const score = rep.lead?.classifier_score ?? null;

    const replyDrafts = sibs
      .filter((s) => s.draft && draftPayload(s.draft).kind !== "dm")
      .map((s) => ({ approvalId: s.approval.id, payload: draftPayload(s.draft) }));
    const angles = buildAnglesFromDrafts(replyDrafts).map((a) => ({
      ...a,
      quality: a.quality ?? score,
    }));
    const dmSib = sibs.find((s) => s.draft && draftPayload(s.draft).kind === "dm");
    const dmPayload = dmSib ? draftPayload(dmSib.draft) : null;
    const dmText = dmPayload ? bodyForSelectedAngle(dmPayload) ?? null : null;
    if (replyDrafts.length === 0 && !dmText) continue;
    const dmOnly = replyDrafts.length === 0;

    out.push({
      id: dmOnly ? dmSib!.approval.id : leadId,
      kind: dmOnly ? "dm" : "reply",
      status: rep.approval.status,
      readyForActor: sibs.some(isXReplyReady),
      dmText,
      dmApprovalId: dmSib?.approval.id ?? null,
      lead: {
        handle: lp.author_handle ? `@${lp.author_handle}` : "—",
        profileUrl: lp.originalPostUrl ?? null,
        tier,
        followers: lp.author_followers ?? null,
        postId: lp.post_id ?? rep.lead?.external_id ?? null,
        recipientId: rep.lead?.author_id ?? lp.author_id ?? null,
        score,
      },
      sourceTweet: lp.post_text ?? null,
      // The real x.com permalink (post_id, else the reliable external_id; null
      // for synthetic seed ids). Drives the per-angle "↗ X" copy-and-open-the-
      // post link, mirroring the LinkedIn card's "Post ↗".
      postUrl: lp.originalPostUrl ?? null,
      pushedAt: rep.approval.created_at ? timeAgo(rep.approval.created_at) : "—",
      angles,
      // Relationship-scout verdict + the identity the VIP banner needs to add the
      // author to the watchlist (X handle, no @) under this lead's intern.
      vipSignal: rep.vipSignal ?? null,
      watchlistRef: lp.author_handle ?? null,
      instanceId: rep.approval.agent_instance_id ?? null,
      alreadyWatched: lp.author_handle
        ? watchedHandles.has(lp.author_handle.toLowerCase())
        : false,
    });
  }
  return out;
}
