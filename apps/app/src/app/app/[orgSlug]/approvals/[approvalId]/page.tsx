import styles from "@/components/approvals/review-detail.module.css";
import { AppLink as Link } from "@/components/nav/AppLink";
import { notFound } from "next/navigation";
import { PageHeader } from "@/components/nav/PageHeader";
import { DraftReviewPanel } from "@/components/approvals/DraftReviewPanel";
import { DMReviewPanel } from "@/components/approvals/DMReviewPanel";
import { VipFlagBanner } from "@/components/approvals/VipFlagBanner";
import { ReviewPager } from "@/components/approvals/ReviewPager";
import { LinkedInApprovalDetailView } from "@/components/approvals/LinkedInApprovalDetailView";
import { RedditApprovalDetailView } from "@/components/approvals/RedditApprovalDetailView";
import {
  getApprovalDetail,
  getLinkedInApprovalDetail,
  getRedditApprovalDetail,
  listPendingRedditApprovals,
  getPersonIdForHandle,
  getWatchlistPeopleForInstance,
  getLinkedInWatchlistPeopleForInstance,
  listPendingApprovalsForOrg,
  listPendingLinkedInApprovals,
  listAgentInstancesForOrg,
  dedupeApprovalsByLead,
  keepLatestPostPerWatchlistedPerson,
  keepLatestLinkedInPostPerPerson,
} from "@/lib/queries";
import { pagerNeighbors } from "@/lib/review-pager";
import {
  parseApprovalFilters,
  approvalFilterQuery,
  parseLinkedInApprovalFilters,
  linkedInApprovalFilterQuery,
} from "@/lib/approval-filters";
import { bodyForSelectedAngle, draftPayload, leadPayload, sentReplyUrl } from "@/lib/payload-shapes";
import { buildAngles, buildAnglesFromDrafts } from "@/lib/build-angles";
import { timeAgo } from "@/lib/utils";

interface PageProps {
  params: Promise<{ orgSlug: string; approvalId: string }>;
  searchParams: Promise<{
    minScore?: string;
    status?: string;
    source?: string;
    watchlist?: string;
    sort?: string;
    batch?: string;
    wlLatest?: string;
  }>;
}

export default async function ApprovalDetailPage({
  params,
  searchParams,
}: PageProps) {
  const { orgSlug, approvalId } = await params;
  const row = await getApprovalDetail(approvalId);
  if (!row) notFound();

  const { approval, lead } = row;

  // LinkedIn intern (Lyra) approvals share noelle.approvals with the X intern
  // but render draft-only (copy + Mark sent — no posting). A lead's
  // platform='linkedin' is the discriminator; branch to the LinkedIn surface
  // before any X-specific assembly runs. getLinkedInApprovalDetail re-asserts
  // org membership itself.
  // Reddit intern (Orion) approvals share noelle.approvals with the X intern
  // but render draft-only (copy + Mark sent — no posting). A lead's
  // platform='reddit' is the discriminator; branch to the Reddit surface before
  // any X-specific assembly runs. getRedditApprovalDetail re-asserts membership.
  if (lead?.platform === "reddit") {
    const detail = await getRedditApprovalDetail(approvalId);
    if (!detail) notFound();
    const liFilters = parseLinkedInApprovalFilters(await searchParams);
    const liLastBatchSince =
      liFilters.batch === "last"
        ? ((await listAgentInstancesForOrg(approval.org_id).catch(() => []))
            .find((i) => i.role === "reddit_intern")?.last_goal_started_at ??
          null)
        : null;
    const redditQueue = await listPendingRedditApprovals(detail.instanceId, 300, {
      status: liFilters.status,
      watchlist: liFilters.watchlist,
      sort: liFilters.sort,
      lastBatchSince: liLastBatchSince,
    }).catch(() => []);
    const ids = redditQueue.map((v) => v.approvalId);
    const anchorId =
      ids.find(
        (id) =>
          id === detail.primary.approvalId ||
          detail.replies.some((r) => r.approvalId === id),
      ) ?? detail.primary.approvalId;
    const idx = ids.indexOf(anchorId);
    const prevId = idx > 0 ? ids[idx - 1] : null;
    const nextId = idx >= 0 && idx < ids.length - 1 ? ids[idx + 1] : null;
    const liQuery = linkedInApprovalFilterQuery(liFilters);
    const navQuery = liQuery
      ? `?stream=reddit-intern&${liQuery.slice(1)}`
      : "?stream=reddit-intern";
    const listHref = `/app/${orgSlug}/approvals${navQuery}`;
    return (
      <RedditApprovalDetailView
        orgSlug={orgSlug}
        detail={detail}
        listHref={listHref}
        prevHref={prevId ? `/app/${orgSlug}/approvals/${prevId}${navQuery}` : null}
        nextHref={nextId ? `/app/${orgSlug}/approvals/${nextId}${navQuery}` : null}
        navQuery={navQuery}
        index={idx}
        total={ids.length}
      />
    );
  }

  if (lead?.platform === "linkedin") {
    const detail = await getLinkedInApprovalDetail(approvalId);
    if (!detail) notFound();
    // Build the per-lead pager over Lyra's pending queue so prev/next walks her
    // inbox, not the X one — under the SAME filters the list used (they ride on
    // the link), so "N of M" and prev/next match what the reviewer saw,
    // including the per-person collapse (?wlLatest=on).
    const liFilters = parseLinkedInApprovalFilters(await searchParams);
    const liLastBatchSince =
      liFilters.batch === "last"
        ? ((await listAgentInstancesForOrg(approval.org_id).catch(() => []))
            .find((i) => i.role === "linkedin_intern")?.last_goal_started_at ??
          null)
        : null;
    const linkedinQueue = await listPendingLinkedInApprovals(
      detail.instanceId,
      300,
      {
        status: liFilters.status,
        watchlist: liFilters.watchlist,
        sort: liFilters.sort,
        lastBatchSince: liLastBatchSince,
      },
    ).catch(() => []);
    const scopedQueue = liFilters.latestPerWatchlisted
      ? keepLatestLinkedInPostPerPerson(linkedinQueue)
      : linkedinQueue;
    const ids = scopedQueue.map((v) => v.approvalId);
    const anchor =
      ids.find(
        (id) =>
          id === detail.primary.approvalId ||
          detail.replies.some((r) => r.approvalId === id) ||
          detail.dm?.approvalId === id,
      ) ?? detail.primary.approvalId;
    const idx = ids.indexOf(anchor);
    const prevId = idx > 0 ? ids[idx - 1] : null;
    const nextId = idx >= 0 && idx < ids.length - 1 ? ids[idx + 1] : null;
    // Nav suffix = Lyra's stream + her active filters, so back/prev/next land on
    // her tab with the same filtered view. The list links carry the filters
    // without `stream` (the detail page branches on the lead's platform), so we
    // re-add the stream here for the return trip.
    const liQuery = linkedInApprovalFilterQuery(liFilters);
    const navQuery = liQuery
      ? `?stream=linkedin-intern&${liQuery.slice(1)}`
      : "?stream=linkedin-intern";
    const listHref = `/app/${orgSlug}/approvals${navQuery}`;
    // Real watchlist membership for the VIP banner's "On watchlist ✓" state, so
    // it survives a reload (Lyra has no priority flag to lean on).
    const liAuthorWatched =
      !!detail.primary.authorPublicId &&
      (await getLinkedInWatchlistPeopleForInstance(detail.instanceId).catch(() => [])).some(
        (p) =>
          (p.public_id ?? "").toLowerCase() ===
          detail.primary.authorPublicId!.toLowerCase(),
      );
    return (
      <LinkedInApprovalDetailView
        orgSlug={orgSlug}
        detail={detail}
        alreadyWatched={liAuthorWatched}
        listHref={listHref}
        prevHref={prevId ? `/app/${orgSlug}/approvals/${prevId}${navQuery}` : null}
        nextHref={nextId ? `/app/${orgSlug}/approvals/${nextId}${navQuery}` : null}
        navQuery={navQuery}
        index={idx}
        total={ids.length}
      />
    );
  }

  // "Lead N of M" stepper + auto-advance target. Walks the SAME queue the
  // reviewer came from: the active filters (minScore/status/source) ride along
  // on the link, so prev/next, N-of-M, and auto-advance match what they see,
  // and the filter survives every hop (filterQuery is re-appended below).
  //
  // Filter-aware (carries minScore/status/source) AND per-lead: walk ONE entry
  // per lead within the active filter scope, so "Lead N of M" doesn't count 4×
  // per lead and the operator's filter survives every prev/next hop. We reuse
  // listPendingApprovalsForOrg (not an ids-only query) so its JS all-skip-draft
  // filter matches the visible queue exactly — prev/next can never point at a
  // row the detail page would 404 on.
  const filters = parseApprovalFilters(await searchParams);
  const { minScore, status: filterStatus, source, watchlist, sort, batch, latestPerWatchlisted } =
    filters;
  const filterQuery = approvalFilterQuery(filters);
  const inFilterScope =
