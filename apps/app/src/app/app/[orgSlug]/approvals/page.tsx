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
      ? { provisioned: true, pending: redditPending }
      : null,
  });
  const activeId = streamParam ?? "x-intern";
  const active = streams.find((s) => s.id === activeId) ?? streams[0];

  const stale =
    !lastSync?.finished_at ||
    Date.now() - new Date(lastSync.finished_at).getTime() > STALE_THRESHOLD_MS;

  const basePath = `/app/${orgSlug}/approvals`;
  const isXIntern = active.id === "x-intern";
  // The LinkedIn stream is live only when Lyra is provisioned; otherwise the
  // tab falls through to the "hire" placeholder via LockedStream.
  const isLinkedIn =
    active.id === "linkedin-intern" && active.status === "live" && !!linkedinInstance;
  // The Reddit stream is live only when Orion is provisioned; otherwise the tab
  // falls through to the "hire" placeholder via LockedStream.
  const isReddit =
    active.id === "reddit-intern" && active.status === "live" && !!redditInstance;

  // Watched-author sets for the VIP banner's "On watchlist ✓" state — sourced
  // from the real watchlist tables so the indicator survives a reload (local
  // button state alone reset to "Add to watchlist" on every refresh). Only
  // fetched for the active stream to avoid a wasted query on the other tabs.
  const xWatchedHandles = new Set<string>(
    isXIntern && xInternInstance
      ? (await getWatchlistPeopleForInstance(xInternInstance.id).catch(() => []))
          .map((p) => p.handle.toLowerCase())
      : [],
  );
  const liWatchedRefs = new Set<string>(
    isLinkedIn && linkedinInstance
      ? (await getLinkedInWatchlistPeopleForInstance(linkedinInstance.id).catch(() => []))
          .map((p) => (p.public_id ?? "").toLowerCase())
          .filter(Boolean)
      : [],
  );

  // Load Lyra's pending review rows only when her tab is the active one (avoid
  // a wasted query on every X-intern render). Every Lyra lead is a watched
  // connection, so the "Per person → latest only" filter (?wlLatest=on)
  // collapses both her Review list and Speedrun to one post per connection.
  const liLastBatchSince =
    liFilters.batch === "last"
      ? (linkedinInstance?.last_goal_started_at ?? null)
      : null;
  const linkedinRowsRaw: LinkedInApprovalView[] =
    isLinkedIn && linkedinInstance
      ? await listPendingLinkedInApprovals(linkedinInstance.id, 300, {
          status: liFilters.status,
          watchlist: liFilters.watchlist,
          sort: liFilters.sort,
          lastBatchSince: liLastBatchSince,
          dedupe: false,
        }).catch(() => [])
      : [];
  const linkedinRows = latestPerWatchlisted
    ? keepLatestLinkedInPostRowsPerPerson(linkedinRowsRaw)
    : linkedinRowsRaw;
  // The "N drafts from Lyra" headline counts REPLY cards only — post-less intro
  // DMs (relationship outreach, hidden by default in the inbox) are not "drafts
  // to a post". Keeps the headline aligned with the badge + the goal count.
  const linkedinVoiceFloor = isLinkedIn ? await loadLinkedInVoiceFloor(org.id) : null;
  const linkedinReviewRows = visibleLinkedInReviewRows(linkedinRows, true, linkedinVoiceFloor);
  const linkedinReplyCount = linkedinReviewRows.filter((row) => row.kind !== "dm").length;
  const linkedinDmCount = linkedinReviewRows.filter((row) => row.kind === "dm").length;
  // Speedrun needs every reply angle per post (the Review inbox is deduped to
  // one representative). Fetch un-deduped + project to SpeedrunDraft[]. When the
  // per-person filter is on, first keep only each connection's newest post's
  // rows (all its angles) so each person still becomes one full speedrun card.
  const linkedinSpeedrunViews =
    isLinkedIn && linkedinInstance
      ? await listPendingLinkedInApprovals(linkedinInstance.id, 300, {
          status: liFilters.status,
          watchlist: liFilters.watchlist,
          sort: liFilters.sort,
          lastBatchSince: liLastBatchSince,
          dedupe: false,
        }).catch(() => [])
      : [];
  const linkedinSpeedrun = toLinkedInSpeedrunDrafts(
    latestPerWatchlisted
      ? keepLatestLinkedInPostRowsPerPerson(linkedinSpeedrunViews)
      : linkedinSpeedrunViews,
    linkedinInstance?.id,
    liWatchedRefs,
    linkedinVoiceFloor,
  );
  const linkedinFilterQuery = linkedInApprovalFilterQuery(liFilters);

  // Orion's pending review rows — only when her tab is active (avoid a wasted
  // query on every other render). Reuses the LinkedIn (reduced) filter schema.
  const redditLastBatchSince =
    liFilters.batch === "last"
      ? (redditInstance?.last_goal_started_at ?? null)
      : null;
  const redditRows: RedditApprovalView[] =
    isReddit && redditInstance
      ? await listPendingRedditApprovals(redditInstance.id, 300, {
          status: liFilters.status,
          watchlist: liFilters.watchlist,
          sort: liFilters.sort,
          lastBatchSince: redditLastBatchSince,
        }).catch(() => [])
      : [];
  const redditReplyCount = redditRows.length;
  // Speedrun needs every reply angle per thread (the Review inbox is deduped to
  // one representative). Fetch un-deduped + project to SpeedrunDraft[].
  const redditSpeedrunViews =
    isReddit && redditInstance
      ? await listPendingRedditApprovals(redditInstance.id, 300, {
          status: liFilters.status,
          watchlist: liFilters.watchlist,
          sort: liFilters.sort,
          lastBatchSince: redditLastBatchSince,
          dedupe: false,
        }).catch(() => [])
      : [];
  const redditSpeedrun = toRedditSpeedrunDrafts(redditSpeedrunViews);
  const redditConfigureHref = redditInstance
    ? agentHref(orgSlug, redditInstance, "config")
    : `/app/${orgSlug}/agents`;
  // Nav suffix the inbox carries onto each detail link: Orion's stream + her
  // active filters, so back/prev/next return to her tab with the same view.
  const redditFilterQuery = linkedInApprovalFilterQuery(liFilters);
  const redditNavQuery = redditFilterQuery
    ? `?stream=reddit-intern&${redditFilterQuery.slice(1)}`
    : "?stream=reddit-intern";

  // The on-page count must match what's actually rendered. pendingCount is the
  // true unfiltered backlog (= the sidebar/tab badge); pendingDisplayCount is
  // the filtered subset actually rendered in the Review inbox — one entry per
  // lead (deduped), not per draft variant — so the title/chip never overstate
  // the cards. (The tab badge stays per-approval.)
  const xReviewRows = visibleXReviewRows(scopedRows, true);
  const pendingDisplayCount = xReviewRows.filter((row) => !isXApprovalDm(row)).length;
  const pendingDmCount = xReviewRows.filter(isXApprovalDm).length;
  // A narrowing filter is active when any queue filter is off its default.
  const filtersActive = hasActiveFilter({
    minScore,
    status,
    source,
    watchlist,
    sort,
    batch,
    latestPerWatchlisted,
  });
  // "Filtered empty" = the pending view rendered nothing ONLY because a filter
  // hid the backlog (there ARE pending drafts, just none matching). This is
  // distinct from a genuinely idle intern, so the empty state can say "no
  // matches / clear filters" instead of "your intern hasn't drafted anything" —
  // the latter reads as broken when e.g. "Watchlist only" is selected but the
  // watchlist queue is momentarily drained even though 30+ keyword drafts wait.
  const filteredEmpty =
    status === "pending" &&
    pendingDisplayCount === 0 &&
    filtersActive &&
    pendingCount > 0;
  // Clear-filters target: the default pending view (drops every filter param).
  const clearFiltersHref = basePath;

  return (
    <>
      <AutoRefresh intervalMs={30_000} />
      <PatternAlertBanner
        orgSlug={orgSlug}
        alerts={patternAlerts.map((a) => ({
          id: a.id,
          ruleId: a.rule_id,
          patternName: a.pattern_name,
          description: a.description,
          severity: a.severity,
          windowSize: a.window_size,
          frequencyCount: a.frequency_count,
          examples: a.examples ?? [],
          status: a.status,
          ruleInstruction: a.rule_instruction,
          suggestion: a.rule_suggestion,
          refineNote: a.refine_note,
          refineRequestId: a.refine_request_id,
          refineClaimed: a.refine_claim_id !== null,
          refineFailed:
            a.status === "open" && a.refine_request_id !== null && a.refine_claim_id !== null,
        }))}
      />
      {linkedinInstance && patternPage === null ? (
        <p role="status">Pattern alerts are unavailable. The draft inbox remains visible.</p>
      ) : null}
      {linkedinInstance && patternPage?.nextCursor ? (
        <p>
          Showing {patternAlerts.length} of {patternPage.total} visible pattern alerts.{" "}
          <Link href={agentHref(orgSlug, linkedinInstance, "patterns")} className="btn btn-sm">
            View pattern history
          </Link>
        </p>
      ) : null}
      <PageHeader
        eyebrow={`Engage · ${active.network}`}
        title={renderTitle(active, pendingDisplayCount, status, {
          isLinkedIn,
          linkedinPending: linkedinReplyCount,
          filteredEmpty,
          isReddit,
          redditPending: redditReplyCount,
        })}
        sub={
          isXIntern && status !== "pending"
            ? `Viewing ${status === "all" ? "all" : status} approvals — read-only.`
            : isXIntern && pendingDisplayCount > 0
              ? "Every reply here passed automatic review and is ready for the actor. Posting still follows its send controls."
              : isXIntern && filteredEmpty
                ? `No pending drafts match these filters — ${pendingCount} ${pendingCount === 1 ? "draft is" : "drafts are"} waiting once you clear them.`
                : isXIntern
                  ? "No X replies are waiting for review. New drafts land here automatically."
                  : isLinkedIn && liFilters.status !== "pending"
                    ? `Viewing ${liFilters.status === "all" ? "all" : liFilters.status} LinkedIn approvals — read-only.`
                  : isLinkedIn && linkedinReplyCount > 0
                  ? "Every reply here passed automatic review and is ready for the actor. You can still open one for manual tools."
                  : isLinkedIn
                    ? "No LinkedIn replies are waiting for review. New drafts for your connections' posts land here automatically."
                    : isReddit && redditRows.length > 0
                      ? "Review replies to relevant threads. Publishing follows your channel settings."
                      : isReddit
                        ? "No Reddit replies are waiting for review. New drafts for threads on your subreddit watchlist land here automatically."
                        : active.desc
        }
        right={
          <>
            <PauseAllButton orgSlug={orgSlug} />
            <Link
              href={`/app/${orgSlug}/settings?tab=channels`}
              className="btn btn-sm btn-ghost"
              style={{ textDecoration: "none" }}
            >
              Channel settings
            </Link>
          </>
        }
      />

      {/* (Removed the Replies / DMs / Posts lane switcher — DMs are toggled
          inline on Lyra's stream via "DMs: on/off", and Posts live in the
          cross-platform Content workspace.) */}

      {stale && isXIntern ? (
        <div
          className="card"
          style={{
            marginBottom: 18,
            padding: "12px 16px",
            background: "color-mix(in oklch, var(--warn) 10%, var(--paper))",
            boxShadow:
              "0 0 0 0.5px color-mix(in oklch, var(--warn) 35%, var(--rule))",
            display: "flex",
            alignItems: "center",
            gap: 12,
          }}
        >
          <span
            style={{
              width: 7,
              height: 7,
              borderRadius: "50%",
              background: "var(--warn)",
              flexShrink: 0,
            }}
          />
          <div style={{ fontSize: 12.5, color: "var(--ink-2)" }}>
            Sync is behind. Last drafts sync{" "}
            <span className="mono">
              {lastSync?.finished_at
                ? timeAgo(lastSync.finished_at)
                : "never ran"}
            </span>
            .
          </div>
        </div>
      ) : null}

      <StreamTabs streams={streams} active={active.id} basePath={basePath} />

      {isXIntern ? (
        <>
          <ApprovalFilters platform="x" basePath={basePath}>
            {batch === "last" && !lastBatchSince ? <span>No goal run yet. Showing all drafts.</span> : null}
            {minScore != null ? <span>Showing scores ≥ {Math.round(minScore * 100)} and unscored leads.</span> : null}
            {latestPerWatchlisted ? <span>Showing the latest post per watchlisted person.</span> : null}
          </ApprovalFilters>
          <XInternStream
            reviewSlot={
              <ReviewInbox
                rows={scopedRows}
                orgSlug={orgSlug}
                orgId={org.id}
                filterQuery={filterQuery}
                filteredEmpty={filteredEmpty}
                clearHref={clearFiltersHref}
              />
            }
            speedrunDrafts={toSpeedrunLeads(scopedRows, xWatchedHandles)}
            basePath={basePath}
            filterQuery={filterQuery}
            totalPending={pendingDisplayCount}
            status={status}
            totalDms={pendingDmCount}
            configureHref={configureHref}
            orgSlug={orgSlug}
            filteredEmpty={filteredEmpty}
            clearHref={clearFiltersHref}
          />
        </>
      ) : isLinkedIn ? (
        <>
          <ApprovalFilters platform="linkedin" basePath={basePath} />
          <LinkedInStream
            reviewSlot={
              <LinkedInReviewInbox
                rows={linkedinRows}
                orgSlug={orgSlug}
                orgId={org.id}
                filterQuery={linkedinFilterQuery}
                voiceFloor={linkedinVoiceFloor}
              />
            }
            speedrunDrafts={linkedinSpeedrun}
            basePath={basePath}
            filterQuery={linkedinFilterQuery}
            orgSlug={orgSlug}
            pending={linkedinReplyCount}
            status={liFilters.status}
            dmCount={linkedinDmCount}
            configureHref={linkedinConfigureHref}
          />
        </>
      ) : isReddit ? (
        <>
          <ApprovalFilters platform="reddit" basePath={basePath} />
          <RedditStream
            reviewSlot={
              <RedditReviewInbox
                rows={redditRows}
                orgSlug={orgSlug}
                orgId={org.id}
                filterQuery={redditNavQuery}
              />
            }
            speedrunDrafts={redditSpeedrun}
            basePath={basePath}
            filterQuery={redditNavQuery}
            orgSlug={orgSlug}
            pending={redditPending}
            configureHref={redditConfigureHref}
          />
        </>
      ) : (
        <ChannelSetupStream
          stream={active}
          basePath={basePath}
          ctaHref={`/app/${orgSlug}/settings?tab=channels`}
        />
      )}
    </>
  );
}

function renderTitle(
  stream: ReturnType<typeof buildStreams>[number],
  totalPending: number,
  status: ApprovalStatusFilter,
  linkedin: {
    isLinkedIn: boolean;
    linkedinPending: number;
    filteredEmpty: boolean;
    isReddit: boolean;
    redditPending: number;
  },
): React.ReactNode {
  if (linkedin.isReddit || linkedin.isLinkedIn) {
    const count = linkedin.isReddit ? linkedin.redditPending : linkedin.linkedinPending;
    return count === 0 ? "Inbox zero" : `${count} ${count === 1 ? "draft" : "drafts"} from ${stream.agentName}`;
  }
  if (stream.id === "x-intern") {
    if (status !== "pending") {
      const label = status === "sent" ? "Sent" : status === "skipped" ? "Skipped" : "All";
      return `${label} approvals from ${stream.agentName}`;
    }
    if (linkedin.filteredEmpty) return "No matches";
    return totalPending === 0
      ? "Inbox zero"
      : `${totalPending} ${totalPending === 1 ? "draft" : "drafts"} from ${stream.agentName}`;
  }
  return stream.network;
}
