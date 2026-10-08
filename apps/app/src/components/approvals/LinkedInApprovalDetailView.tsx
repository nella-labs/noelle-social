import styles from "./review-detail.module.css";
import { AppLink as Link } from "@/components/nav/AppLink";
import { PageHeader } from "@/components/nav/PageHeader";
import { ReviewPager } from "@/components/approvals/ReviewPager";
import { LinkedInReviewPanel } from "@/components/approvals/LinkedInReviewPanel";
import { VipFlagBanner } from "@/components/approvals/VipFlagBanner";
import type { LinkedInApprovalDetail } from "@/lib/queries";
import { timeAgo } from "@/lib/utils";

/**
 * Detail surface for a single LinkedIn intern (Lyra) approval.
 *
 * Server component (so the `timeAgo` `Date.now()` runs at render, never on a
 * client hydration pass). Mirrors the X intern's detail layout — left column is
 * the draft picker, right column is the source post + context — but DRAFT-ONLY:
 * the only actions are copy + "Mark sent" (see LinkedInReviewPanel). There is
 * no "Send" / "Open in LinkedIn" action because Lyra never posts to LinkedIn.
 *
 * The reply-angle picker + DM both live in the client `LinkedInReviewPanel`; the
 * static post + author cards stay server-rendered here.
 */
interface Props {
  orgSlug: string;
  detail: LinkedInApprovalDetail;
  /** Whether this author is already on Lyra's watchlist (VIP banner state). */
  alreadyWatched?: boolean;
  listHref: string;
  prevHref: string | null;
  nextHref: string | null;
  /** Nav suffix (stream + active filters) the pager appends to prev/next ids. */
  navQuery?: string;
  index: number;
  total: number;
}

export function LinkedInApprovalDetailView({
  orgSlug,
  detail,
  alreadyWatched = false,
  listHref,
  prevHref,
  nextHref,
  navQuery = "?stream=linkedin-intern",
  index,
  total,
}: Props) {
  const { primary, replies, dm } = detail;

  // Pending reply angles + the DM (if pending) are the actionable set. Once
  // everything is actioned we show a quiet resolved banner instead.
  const pendingReplies = replies.filter((r) => r.status === "pending");
  const pendingDm = dm && dm.status === "pending" ? dm : null;
  const anyPending = pendingReplies.length > 0 || !!pendingDm;

  const name = primary.authorName;
  const isDmOnly = pendingReplies.length === 0 && !!pendingDm;
  const verb = isDmOnly ? "DM" : "Reply";
  const pushed = primary.createdAt ? timeAgo(primary.createdAt) : "—";

  // Derive prev/next ids back out of the hrefs the page built (ReviewPager
  // takes bare ids + a separate query suffix, not full urls). Strip any query
  // string first so the filter suffix doesn't leak into the id.
  const prevId = prevHref
    ? prevHref.split("?")[0]!.split("/").pop() ?? null
    : null;
  const nextId = nextHref
    ? nextHref.split("?")[0]!.split("/").pop() ?? null
    : null;
  const showPager = index !== -1 && total > 1;

  return (
    <>
      <PageHeader
        eyebrow={`LinkedIn Intern · lead · ${primary.approvalId.slice(0, 8)}`}
        title={
          <>
            {verb} to <em>{name}</em>
          </>
        }
        sub={
          anyPending ? (
            <>
              Pushed {pushed}. This reply passed automatic review and is ready
              for the actor when automatic replies are on. You can also copy it,
              post it yourself, and mark it sent.
            </>
          ) : (
            <>This draft has been actioned. Pushed {pushed}.</>
          )
        }
        right={
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            {showPager ? (
              <ReviewPager
                orgSlug={orgSlug}
                index={index}
                total={total}
                prevId={prevId}
                nextId={nextId}
                query={navQuery}
              />
            ) : null}
            <Link
              href={listHref}
              className="btn btn-sm btn-ghost"
              style={{ textDecoration: "none" }}
            >
              ← All drafts
            </Link>
          </div>
        }
      />

      <div className={styles.grid}>
        {/* LEFT — the draft picker (copy + mark sent only) or a resolved banner.
            When the scout flagged this author, the VIP banner sits loud above the
            picker so the operator weighs a relationship move before marking sent. */}
        {anyPending ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            {detail.vipSignal?.vip ? (
              <VipFlagBanner
                orgSlug={orgSlug}
                instanceId={detail.instanceId}
                approvalId={primary.approvalId}
                platform="linkedin"
                authorLabel={name}
                watchlistRef={primary.authorPublicId}
                profileUrl={primary.profileUrl}
                alreadyWatched={alreadyWatched}
                signal={detail.vipSignal}
              />
            ) : null}
            <LinkedInReviewPanel
              orgSlug={orgSlug}
              replies={pendingReplies}
              dm={pendingDm}
              nextHref={nextHref}
              listHref={listHref}
            />
          </div>
        ) : (
          <ResolvedBanner detail={detail} />
        )}

        {/* RIGHT — the source post + author + context cards. */}
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <div className="tweet">
            <div className="tweet-head">
              <div
                style={{
                  width: 42,
                  height: 42,
                  borderRadius: "50%",
                  background: "var(--paper-2)",
                  boxShadow: "0 0 0 0.5px var(--rule)",
                  display: "grid",
                  placeItems: "center",
                  fontFamily: "var(--display)",
                  fontSize: 18,
                  color: "var(--ink)",
                }}
              >
                {name?.[0]?.toUpperCase() ?? "?"}
              </div>
              <div style={{ minWidth: 0 }}>
                <div className="tweet-h-name">
                  {primary.profileUrl ? (
                    <a
                      href={primary.profileUrl}
                      target="_blank"
                      rel="noreferrer"
                      style={{ color: "inherit", textDecoration: "none" }}
                    >
                      {name}
                    </a>
                  ) : (
                    name
                  )}
                </div>
                {primary.authorHeadline ? (
                  <div className="tweet-h-handle">{primary.authorHeadline}</div>
                ) : primary.authorPublicId ? (
                  <div className="tweet-h-handle">
                    in/{primary.authorPublicId}
                  </div>
                ) : null}
              </div>
              {primary.postUrl ? (
                <a
                  href={primary.postUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="btn btn-sm btn-ghost"
                  style={{
                    marginLeft: "auto",
                    textDecoration: "none",
                    whiteSpace: "nowrap",
                  }}
                >
                  View post ↗
