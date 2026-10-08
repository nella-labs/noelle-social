/**
 * Project un-deduped LinkedIn approval views (one per reply angle / DM) into one
 * `SpeedrunDraft` per source post — the reply angles become the card's angle
 * radios. The LinkedIn sibling of `toSpeedrunLeads` (X), for Lyra's draft-only
 * data: no tier/score/recipient and no DM (auto-DM is off; on-demand DMs are
 * generated per-person elsewhere). Fetch the views with `{ dedupe: false }` so
 * every angle is present.
 */
import type { LinkedInApprovalView } from "@/lib/queries";
import type { SpeedrunDraft } from "@/components/approvals/SpeedrunRow";
import { timeAgo } from "@/lib/utils";
import { isLinkedInReplyReady } from "@/lib/reply-readiness";

export function toLinkedInSpeedrunDrafts(
  views: LinkedInApprovalView[],
  /** The LinkedIn intern instance id — scopes the VIP banner's watchlist add. */
  instanceId?: string,
  /**
   * Lowercased LinkedIn public_ids already on Lyra's watchlist. Drives the VIP
   * banner's "On watchlist ✓" state so it survives a reload. Empty = none.
   */
  watchedRefs: Set<string> = new Set(),
  voiceFloor: number | null = 0.7,
): SpeedrunDraft[] {
  const order: string[] = [];
  const byPost = new Map<string, LinkedInApprovalView[]>();
  for (const v of views) {
    // Key on the source post (author + post) so the reply angles for one post
    // collapse into a single card.
    const key = `${v.authorPublicId ?? v.authorName}|${v.postUrl ?? v.postText ?? ""}`;
    if (!byPost.has(key)) {
      byPost.set(key, []);
      order.push(key);
    }
    byPost.get(key)!.push(v);
  }

  const out: SpeedrunDraft[] = [];
  for (const key of order) {
    const group = byPost.get(key)!;
    const replies = group.filter(
      (v) => v.kind === "reply" && v.body != null && v.body.trim().length > 0,
    );
    const dm = group.find(
      (v) => v.kind === "dm" && v.body != null && v.body.trim().length > 0,
    );
    if (replies.length === 0 && !dm) continue;
    const rep = replies.find((reply) => isLinkedInReplyReady(reply, voiceFloor)) ?? replies[0] ?? dm!;
    const dmOnly = replies.length === 0;
    const angles = replies.map((v) => ({
      id: v.approvalId,
      approvalId: v.approvalId,
      kind: v.angle
        ? v.angle[0]!.toUpperCase() + v.angle.slice(1)
        : "Reply",
      text: v.body ?? "",
      quality: null,
      // Per-angle voice blend → the "Style: …%" badge on the speedrun card.
      styleSource: v.styleSource,
    }));
    out.push({
      // The card id doubles as the "Full review →" target, and the LinkedIn
      // detail page is keyed by approvalId — use the representative reply's.
      id: rep.approvalId,
      kind: dmOnly ? "dm" : "reply",
      status: rep.status,
      readyForActor: replies.some((reply) => isLinkedInReplyReady(reply, voiceFloor)),
      reviewPolicyAvailable: voiceFloor !== null,
      dmText: dm?.body ?? null,
      dmApprovalId: dm?.approvalId ?? null,
      lead: {
        handle: rep.authorName ?? rep.authorPublicId ?? "—",
        profileUrl: rep.profileUrl,
        tier: null,
        followers: null,
        postId: null,
        recipientId: null,
        score: null,
      },
      sourceTweet: rep.postText,
      postUrl: rep.postUrl,
      pushedAt: rep.createdAt ? timeAgo(rep.createdAt) : "—",
      angles,
      // Relationship-scout verdict + the identity the VIP banner needs to add the
      // author to Lyra's watchlist (LinkedIn public_id).
      vipSignal: rep.vipSignal ?? null,
      watchlistRef: rep.authorPublicId ?? null,
      instanceId: instanceId ?? null,
      alreadyWatched: rep.authorPublicId
        ? watchedRefs.has(rep.authorPublicId.toLowerCase())
        : false,
    });
  }
  return out;
}
