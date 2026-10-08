import { AppLink as Link } from "@/components/nav/AppLink";
import { notFound } from "next/navigation";
import { PageHeader } from "@/components/nav/PageHeader";
import { PauseAllButton } from "../agents/[instanceId]/PauseAllButton";
import { AutoRefresh } from "./AutoRefresh";
import { ReviewInbox } from "@/components/approvals/ReviewInbox";
import { XInternStream } from "@/components/approvals/XInternStream";
import { LinkedInReviewInbox } from "@/components/approvals/LinkedInReviewInbox";
import { RedditReviewInbox } from "@/components/approvals/RedditReviewInbox";
import { RedditStream } from "@/components/approvals/RedditStream";
import { LinkedInStream } from "@/components/approvals/LinkedInStream";
import { PatternAlertBanner } from "@/components/approvals/PatternAlertBanner";
import { StreamTabs } from "@/components/approvals/StreamTabs";
import { ChannelSetupStream } from "@/components/approvals/ChannelSetupStream";
import { ApprovalFilters } from "@/components/approvals/ApprovalFilters";
import {
  countPendingApprovalsForOrg,
  countPendingLinkedInApprovals,
  keepLatestPostPerWatchlistedPerson,
  keepLatestLinkedInPostRowsPerPerson,
  getLastSyncRun,
  getLinkedInInternInstance,
  getRedditInternInstance,
  countPendingRedditApprovals,
  listPendingRedditApprovals,
  getOrgBySlug,
  getWatchlistPeopleForInstance,
  getLinkedInWatchlistPeopleForInstance,
  listAgentInstancesForOrg,
  listPendingApprovalsForOrg,
  listPendingLinkedInApprovals,
  listVisiblePatternAlerts,
  type ApprovalStatusFilter,
  type LinkedInApprovalView,
  type RedditApprovalView,
} from "@/lib/queries";
import {
  parseApprovalFilters,
  approvalFilterQuery,
  parseLinkedInApprovalFilters,
  linkedInApprovalFilterQuery,
  hasActiveFilter,
} from "@/lib/approval-filters";
import { toLinkedInSpeedrunDrafts } from "@/lib/to-linkedin-speedrun";
import { toRedditSpeedrunDrafts } from "@/lib/to-reddit-speedrun";
import { agentHref } from "@/lib/agent-route";
import { buildStreams } from "@/lib/approval-streams";
import { toSpeedrunLeads } from "@/lib/to-speedrun-draft";
import { timeAgo } from "@/lib/utils";
import { loadLinkedInVoiceFloor } from "@/lib/linkedin-review-policy";
import {
  isXApprovalDm,
  visibleLinkedInReviewRows,
  visibleXReviewRows,
} from "@/lib/dm-visibility";

interface PageProps {
  params: Promise<{ orgSlug: string }>;
  /**
   * `?stream=<id>` selects which agent's approval queue is in view.
   * `?minScore=<0..1>` filters the X-intern queue to leads whose
   * classifier_score clears the floor (NULL scores still pass through —
   * see ListPendingApprovalsOptions).
   * `?status=<sent|skipped|all>` switches the queue off the default pending
   * view; `?source=<synthetic|all>` reveals test/synthetic leads (hidden by
   * default).
   */
  searchParams: Promise<{
    stream?: string;
    minScore?: string;
    status?: string;
    source?: string;
    watchlist?: string;
    sort?: string;
    batch?: string;
    wlLatest?: string;
  }>;
}

const STALE_THRESHOLD_MS = 5 * 60 * 1000;

export default async function ApprovalsInboxPage({
  params,
  searchParams,
}: PageProps) {
  const { orgSlug } = await params;
  const {
    stream: streamParam,
    minScore: minScoreParam,
    status: statusParam,
    source: sourceParam,
    watchlist: watchlistParam,
    sort: sortParam,
    batch: batchParam,
    wlLatest: wlLatestParam,
  } = await searchParams;
  const org = await getOrgBySlug(orgSlug);
  if (!org) notFound();

  const { minScore, status, source, watchlist, sort, batch, latestPerWatchlisted } =
    parseApprovalFilters({
      minScore: minScoreParam,
      status: statusParam,
      source: sourceParam,
      watchlist: watchlistParam,
      sort: sortParam,
      batch: batchParam,
      wlLatest: wlLatestParam,
    });
  // LinkedIn (Lyra) reads the SAME url params through a reduced schema (no
  // score/source; sort defaults to newest_post). Parsed separately so the X
  // path is untouched. The per-person filter (latestPerWatchlisted, from
  // ?wlLatest) is shared — it rides the X parse above and gates Lyra's collapse.
  const liFilters = parseLinkedInApprovalFilters({
    status: statusParam,
    watchlist: watchlistParam,
    sort: sortParam,
    batch: batchParam,
  });

  // The "Last batch" filter needs the X intern's last_goal_started_at, so fetch
  // instances first. When the user never ran a goal there's no batch to show, so
  // the filter no-ops (lastBatchSince stays null) rather than emptying the inbox.
  const instances = await listAgentInstancesForOrg(org.id);
  const xInternInstance = instances.find((i) => i.role === "x_intern");
  const lastBatchSince =
    batch === "last" ? (xInternInstance?.last_goal_started_at ?? null) : null;

  // Carry the active filters onto every list→detail link so the detail page's
  // stepper walks the same filtered set (and keeps it across prev/next).
  const filterQuery = approvalFilterQuery({
    minScore,
    status,
    source,
    watchlist,
    sort,
    batch,
    latestPerWatchlisted,
  });

  // `instances` (and xInternInstance/lastBatchSince) were already fetched above
  // for the Last-batch filter — don't re-fetch them here.
  const [rows, pendingCount, lastSync, linkedinInstance] =
    await Promise.all([
      // Pending is the actionable backlog — load enough that every draft is
      // reviewable (not an arbitrary 50 that silently hid 30+ drafts), with a
      // sane upper bound. Non-pending views stay a capped lens over past work.
      listPendingApprovalsForOrg(
        org.id,
        status === "pending" ? 300 : 50,
        { minScore, status, source, watchlist, sort, lastBatchSince },
      ),
      countPendingApprovalsForOrg(org.id),
      getLastSyncRun("drafter"),
      // The LinkedIn intern (Lyra), if provisioned — drives whether the
      // LinkedIn approvals tab is live and its pending badge.
      getLinkedInInternInstance(org.id).catch(() => null),
    ]);

  // Orion's instance + pending count (per-lead) for her tab badge. Cheap — only
  // when she exists. Her drafts queue here draft-only (copy + mark sent).
  const redditInstance = await getRedditInternInstance(org.id).catch(() => null);
  const redditPending = redditInstance
    ? await countPendingRedditApprovals(redditInstance.id).catch(() => 0)
    : 0;

  // Lyra's pending reply count (per post) for the tab badge.
  const linkedinPending = linkedinInstance
    ? await countPendingLinkedInApprovals(linkedinInstance.id).catch(() => 0)
    : 0;

  // A bounded visible page keeps continuation explicit; unavailable is distinct from measured empty.
  const patternPage = linkedinInstance
    ? await listVisiblePatternAlerts(linkedinInstance.id).catch(() => null)
    : null;
  const patternAlerts = patternPage?.alerts ?? [];
  // Optionally collapse each watchlisted person to just their newest post
  // (?wlLatest=on) BEFORE the per-lead/per-draft grouping, so Review + Speedrun
  // (and the detail stepper, which applies the same step) all walk one post per
  // watched person. Non-watchlisted leads are untouched.
  const scopedRows = latestPerWatchlisted
    ? keepLatestPostPerWatchlistedPerson(rows)
    : rows;
  const configureHref = xInternInstance
    ? agentHref(orgSlug, xInternInstance, "config")
    : `/app/${orgSlug}/agents`;
  // Deep link to Lyra's config (same shape as Vega's) for the LinkedIn stream's
  // "Configure agent →" button. Falls back to the agents grid if she's somehow
  // not resolved (the LinkedIn tab is only live when she is, so this is belt-
  // and-suspenders).
  const linkedinConfigureHref = linkedinInstance
    ? agentHref(orgSlug, linkedinInstance, "config")
    : `/app/${orgSlug}/agents`;

  const streams = buildStreams({
    xInternPending: pendingCount,
    linkedinIntern: linkedinInstance
      ? { provisioned: true, pending: linkedinPending }
      : null,
    redditIntern: redditInstance
