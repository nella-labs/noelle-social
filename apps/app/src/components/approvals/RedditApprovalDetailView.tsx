import styles from "./review-detail.module.css";
import { AppLink as Link } from "@/components/nav/AppLink";
import { PageHeader } from "@/components/nav/PageHeader";
import { ReviewPager } from "@/components/approvals/ReviewPager";
import { RedditReviewPanel } from "@/components/approvals/RedditReviewPanel";
import type { RedditApprovalDetail } from "@/lib/queries";
import { timeAgo } from "@/lib/utils";

/**
 * Detail surface for a single Reddit intern (Orion) approval.
 *
 * Server component (so the `timeAgo` `Date.now()` runs at render, never on a
 * client hydration pass). Mirrors the LinkedIn intern's detail layout — left
 * column is the draft picker, right column is the source thread + context.
 * Orion AUTO-SENDS: everything in this queue is treated as approved and is
 * posted to Reddit automatically by the Reddit actuator (from the operator's
 * logged-in tab). The review surface is for editing or SKIPPING a reply before
 * it goes out — Skip is the veto. No DM lane (Reddit is replies-only).
 */
interface Props {
  orgSlug: string;
  detail: RedditApprovalDetail;
  listHref: string;
  prevHref: string | null;
  nextHref: string | null;
  navQuery?: string;
  index: number;
  total: number;
}

export function RedditApprovalDetailView({
  orgSlug,
  detail,
  listHref,
  prevHref,
  nextHref,
  navQuery = "?stream=reddit-intern",
  index,
  total,
}: Props) {
  const { primary, replies } = detail;

  const pendingReplies = replies.filter((r) => r.status === "pending");
  const anyPending = pendingReplies.length > 0;

  const sub = primary.subreddit ? `r/${primary.subreddit}` : "a subreddit";
  const author = primary.authorHandle ? `u/${primary.authorHandle}` : null;
  const pushed = primary.createdAt ? timeAgo(primary.createdAt) : "—";

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
        eyebrow={`Reddit Intern · thread · ${primary.approvalId.slice(0, 8)}`}
        title={
          <>
            Reply in <em>{sub}</em>
          </>
        }
        sub={
          anyPending ? (
            <>
              Approved — Orion auto-sends this reply via the Reddit actuator.{" "}
              Pushed {pushed}. <strong>Skip it if you don&rsquo;t want it posted.</strong>
            </>
          ) : (
            <>This reply has been actioned. Pushed {pushed}.</>
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
        {/* LEFT — the draft picker (copy + mark sent only) or a resolved banner. */}
        {anyPending ? (
          <RedditReviewPanel
            orgSlug={orgSlug}
            replies={pendingReplies}
            nextHref={nextHref}
            listHref={listHref}
          />
        ) : (
          <ResolvedBanner detail={detail} />
        )}

        {/* RIGHT — the source thread + context cards. */}
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
                {primary.subreddit?.[0]?.toUpperCase() ?? "r"}
              </div>
              <div style={{ minWidth: 0 }}>
                <div className="tweet-h-name">
                  {primary.postUrl ? (
                    <a
                      href={primary.postUrl}
                      target="_blank"
                      rel="noreferrer"
                      style={{ color: "inherit", textDecoration: "none" }}
                    >
                      {sub}
                    </a>
                  ) : (
                    sub
                  )}
                </div>
                {author ? <div className="tweet-h-handle">{author}</div> : null}
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
                  View thread ↗
                </a>
              ) : null}
            </div>
            {primary.threadTitle ? (
              <div
                className="serif"
                style={{ fontSize: 18, lineHeight: 1.3, margin: "4px 0 8px" }}
              >
                {primary.threadTitle}
              </div>
            ) : null}
            <div className="tweet-body" style={{ whiteSpace: "pre-wrap" }}>
              {primary.postText ?? "(thread text not synced yet)"}
            </div>
            <div className="tweet-meta">
              <span>Reddit</span>
              {primary.subreddit ? <span>r/{primary.subreddit}</span> : null}
            </div>
          </div>

          <div className="card">
            <div className="eyebrow">How Orion works</div>
            <div
              style={{
                marginTop: 10,
                fontSize: 12.5,
                color: "var(--ink-muted)",
                lineHeight: 1.5,
              }}
            >
              Orion sweeps the subreddits on your watchlist for in-ICP threads,
              then drafts an on-brand reply for each and auto-sends it via the
              Reddit actuator (posting from your logged-in tab). Replies only, no
              DMs. Everything queued here is treated as approved — edit or Skip a
              reply before it goes out.
            </div>
          </div>
        </div>
