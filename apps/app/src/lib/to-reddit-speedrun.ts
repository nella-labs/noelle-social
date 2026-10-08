/**
 * Project un-deduped Reddit approval views (one per reply angle) into one
 * `SpeedrunDraft` per source thread — the reply angles become the card's angle
 * radios. The Reddit sibling of `toLinkedInSpeedrunDrafts`, for Orion's reply
 * data: no tier/score/recipient and no DM (Reddit is replies-only).
 * Fetch the views with `{ dedupe: false }` so every angle is present.
 */
import type { RedditApprovalView } from "@/lib/queries";
import type { SpeedrunDraft } from "@/components/approvals/SpeedrunRow";
import { timeAgo } from "@/lib/utils";

export function toRedditSpeedrunDrafts(
  views: RedditApprovalView[],
): SpeedrunDraft[] {
  const order: string[] = [];
  const byThread = new Map<string, RedditApprovalView[]>();
  for (const v of views) {
    // Key on the source thread (same key the inbox dedupes by) so the reply
    // angles for one thread collapse into a single card.
    const key =
      v.postUrl ?? `${v.subreddit ?? ""}::${v.threadTitle ?? v.approvalId}`;
    if (!byThread.has(key)) {
      byThread.set(key, []);
      order.push(key);
    }
    byThread.get(key)!.push(v);
  }

  const out: SpeedrunDraft[] = [];
  for (const key of order) {
    const group = byThread.get(key)!;
    const replies = group.filter(
      (v) => v.body != null && v.body.trim().length > 0,
    );
    if (replies.length === 0) continue;
    const rep = replies[0]!;
    const angles = replies.map((v, i) => ({
      id: v.approvalId,
      approvalId: v.approvalId,
      // Reddit drafts carry no named angle, so number them only when there's
      // more than one to disambiguate ("Reply" when there's a single draft).
      kind: replies.length > 1 ? `Reply ${i + 1}` : "Reply",
      text: v.body ?? "",
      quality: null,
    }));
    out.push({
      // The card id doubles as the "Full review →" target, and the Reddit
      // detail page is keyed by approvalId — use the representative reply's.
      id: rep.approvalId,
      kind: "reply",
      dmText: null,
      lead: {
        handle: rep.authorHandle
          ? `u/${rep.authorHandle}`
          : rep.subreddit
            ? `r/${rep.subreddit}`
            : "—",
        profileUrl: rep.authorHandle
          ? `https://www.reddit.com/user/${rep.authorHandle}`
          : null,
        tier: null,
        followers: null,
        postId: null,
        recipientId: null,
        score: null,
      },
      sourceTweet: rep.threadTitle ?? rep.postText,
      postUrl: rep.postUrl,
      pushedAt: rep.createdAt ? timeAgo(rep.createdAt) : "—",
      angles,
    });
  }
  return out;
}
