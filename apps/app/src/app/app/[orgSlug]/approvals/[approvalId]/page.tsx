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
    filterStatus === "all" || filterStatus === approval.status;
  // Match the list's "Last batch" scope so the stepper walks the same set.
  const lastBatchSince =
    inFilterScope && batch === "last"
      ? ((await listAgentInstancesForOrg(approval.org_id).catch(() => []))
          .find((i) => i.role === "x_intern")?.last_goal_started_at ?? null)
      : null;
  const scopeRows = inFilterScope
    ? await listPendingApprovalsForOrg(
        approval.org_id,
        filterStatus === "pending" ? 300 : 50,
        { minScore, status: filterStatus, source, watchlist, sort, lastBatchSince },
      ).catch(() => [])
    : [];
  const pendingIds = dedupeApprovalsByLead(
    latestPerWatchlisted
      ? keepLatestPostPerWatchlistedPerson(scopeRows)
      : scopeRows,
  ).map((r) => r.approval.id);
  // The clicked approval may not be the per-lead representative; anchor the
  // pager on whichever representative shares this lead so prev/next still work.
  const pagerAnchor =
    pendingIds.find((id) => row.siblings.some((s) => s.approval.id === id)) ??
    approval.id;
  const pager = pagerNeighbors(pendingIds, pagerAnchor);
  const showPager = pager.index !== -1 && pager.total > 1;
  const nextHref = pager.nextId
    ? `/app/${orgSlug}/approvals/${pager.nextId}${filterQuery}`
    : null;

  const lp = leadPayload(lead);

  // Assemble the WHOLE lead onto one page: every reply angle (each its own
  // approval row) plus the DM. The clicked approval is just the entry point.
  const replyDrafts = row.siblings
    .filter((s) => s.draft && draftPayload(s.draft).kind !== "dm")
    .map((s) => ({
      approvalId: s.approval.id,
      status: s.approval.status,
      payload: draftPayload(s.draft),
    }));
  const dmSibling = row.siblings.find(
    (s) => s.draft && draftPayload(s.draft).kind === "dm",
  );
  const dmPayload = dmSibling ? draftPayload(dmSibling.draft) : null;
  const dmBody = dmPayload ? bodyForSelectedAngle(dmPayload) ?? "" : "";
  const dmPending = dmSibling?.approval.status === "pending";
  const dmApprovalId = dmSibling?.approval.id ?? approval.id;

  const handle = lp.author_handle ? `@${lp.author_handle}` : "—";
  const handleUrl = lp.originalPostUrl ?? null;
  // Internal contact page (profile + every reply/DM drafted for them). Contacts
  // is the single person surface, so this links into /contacts/[id] — present
  // only when the author is a known contact (i.e. watchlisted at some point).
  const personId =
    approval.org_id && lp.author_handle
      ? await getPersonIdForHandle(approval.org_id, lp.author_handle)
      : null;
  const personHref = personId ? `/app/${orgSlug}/contacts/${personId}` : null;
  // Real watchlist membership for the VIP banner's "On watchlist ✓" state —
  // `lead.priority` only flags leads that CAME from the watchlist lane, so a
  // person added via the banner (whose existing lead isn't priority) would
  // otherwise show "Add to watchlist" again after a reload. Check the actual
  // x_watchlist_people table for this author's handle instead.
  const authorWatched =
    (lead?.priority ?? false) ||
    (!!lp.author_handle &&
      (await getWatchlistPeopleForInstance(approval.agent_instance_id).catch(() => [])).some(
        (p) => p.handle.toLowerCase() === lp.author_handle!.toLowerCase(),
      ));
  const followers = lp.author_followers;
  const followerLabel =
    followers != null ? `${(followers / 1000).toFixed(1)}k followers` : null;
  const postText = lp.post_text;
  const postedAt = lp.posted_at;
  // Real classifier columns (cloudsql/0005) trump the payload mirror — the
  // discovery worker doesn't populate them.
  const tier = lead?.tier ?? lp.tier ?? null;
  const classifierScore = lead?.classifier_score ?? null;
  const classifierLabel = lead?.classifier_label ?? null;
  const trigger = lp.matched_trigger_id ?? null;
  // Voice anchors the drafter used to ground this lead's drafts (persisted via
  // the outbound payload). Empty when the lead predates anchor persistence.
  const anchors = lp.anchors ?? [];

  // Reply angles still pending (the picker) vs. all of them (for the actioned
  // banner). Each angle carries its own approvalId so "approve" sends the
  // selected one; the send handler auto-skips the other reply siblings.
  const withQuality = <T extends { quality?: number | null }>(a: T): T => ({
    ...a,
    quality: a.quality ?? classifierScore,
  });
  const angles = buildAnglesFromDrafts(
    replyDrafts.filter((d) => d.status === "pending"),
  ).map(withQuality);
  const bannerAngles = buildAnglesFromDrafts(replyDrafts).map(withQuality);

  // Lead-level disposition: act while anything is pending; otherwise show the
  // banner reflecting what already happened (sent wins over skipped).
  const anyPending = angles.length > 0 || dmPending;
  const sentSibling = row.siblings.find((s) => s.approval.status === "sent");
  const leadStatus = sentSibling
    ? "sent"
    : row.siblings.some((s) => s.approval.status === "skipped")
      ? "skipped"
      : approval.status;
  const isActioned = !anyPending;
  const postedUrl = sentSibling
    ? sentReplyUrl({
        sentUrl: draftPayload(sentSibling.draft).sent_url,
        authorHandle: lp.author_handle,
      })
    : null;

  // The classifier mirrors tier, classifier_score, classifier_label onto
  // noelle.leads — if any landed we consider the classifier "synced".
  const classifierKnown =
    classifierScore != null || tier != null || classifierLabel != null;
  const pushed = approval.created_at ? timeAgo(approval.created_at) : "—";

  return (
    <>
      <PageHeader
        eyebrow={`X Intern · lead · ${approval.id.slice(0, 8)}`}
        title={
          <>
            Engage{" "}
            {personHref ? (
              <Link href={personHref} style={{ color: "inherit" }} title="View this contact">
                <em>{handle}</em>
              </Link>
            ) : (
              <em>{handle}</em>
            )}
          </>
        }
        sub={
          anyPending ? (
            <>
              {angles.length > 0
                ? `Pick one of ${angles.length} reply angle${angles.length === 1 ? "" : "s"}`
                : "No reply angle left"}
              {dmPending ? " and/or send the DM" : ""}, then approve. Pushed{" "}
              {pushed}.
            </>
          ) : (
            <>This lead has been actioned. Pushed {pushed}.</>
          )
        }
        right={
          <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            {postedUrl ? (
              <a
                href={postedUrl}
                target="_blank"
                rel="noreferrer"
                className="btn btn-sm btn-primary"
                style={{ textDecoration: "none" }}
                title="Open Vega's posted reply on X"
              >
                View reply on X ↗
              </a>
            ) : null}
            {showPager ? (
              <ReviewPager
                orgSlug={orgSlug}
                index={pager.index}
                total={pager.total}
                prevId={pager.prevId}
                nextId={pager.nextId}
                query={filterQuery}
              />
            ) : null}
            <Link
              href={`/app/${orgSlug}/approvals${filterQuery}`}
              className="btn btn-sm btn-ghost"
              style={{ textDecoration: "none" }}
            >
              ← All drafts
            </Link>
          </div>
        }
      />

      <div className={styles.grid}>
        {/* LEFT — reply angle picker + the DM, both on one page; or, once the
            whole lead is actioned, a single post-action banner. */}
        {isActioned ? (
          <ActionedBanner
            status={leadStatus}
            postedUrl={postedUrl}
            skipReason={approval.skip_reason}
            decidedAt={approval.decided_at}
            angles={bannerAngles}
            isDM={false}
            dmBody={dmBody}
          />
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            {row.vipSignal?.vip ? (
              <VipFlagBanner
                orgSlug={orgSlug}
                instanceId={approval.agent_instance_id}
                approvalId={approval.id}
                platform="x"
                authorLabel={handle}
                watchlistRef={lp.author_handle ?? null}
                profileUrl={handleUrl}
                alreadyWatched={authorWatched}
                signal={row.vipSignal}
              />
            ) : null}
            {angles.length > 0 ? (
              <DraftReviewPanel
                orgSlug={orgSlug}
                approvalId={approval.id}
                angles={angles}
                nextHref={nextHref}
                listHref={`/app/${orgSlug}/approvals${filterQuery}`}
                postId={lp.post_id ?? lead?.external_id ?? null}
              />
            ) : null}
            {dmPending ? (
              <DMReviewPanel
                orgSlug={orgSlug}
                approvalId={dmApprovalId}
                body={dmBody}
                nextHref={nextHref}
                listHref={`/app/${orgSlug}/approvals${filterQuery}`}
                recipientId={lead?.author_id ?? lp.author_id ?? null}
              />
            ) : null}
          </div>
        )}

        {/* RIGHT — source tweet + lead/classifier/cost cards */}
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
                {lp.author_handle?.[0]?.toUpperCase() ?? "?"}
              </div>
              <div>
                <div className="tweet-h-name">
                  {handleUrl ? (
                    <a
                      href={handleUrl}
                      target="_blank"
                      rel="noreferrer"
                      style={{ color: "inherit", textDecoration: "none" }}
                    >
                      {handle}
                    </a>
                  ) : (
                    handle
                  )}
                </div>
                <div className="tweet-h-handle">
                  {handle}
                  {postedAt ? ` · ${timeAgo(postedAt)}` : ""}
                </div>
              </div>
              {handleUrl ? (
                <a
                  href={handleUrl}
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
                </a>
              ) : null}
            </div>
            <div className="tweet-body">
              {postText ?? "(post text not synced yet)"}
            </div>
            <div className="tweet-meta">
              {followerLabel ? <span>{followerLabel}</span> : null}
              {tier ? <span>tier {tier}</span> : null}
              {classifierScore != null ? (
                <span>score {Math.round(classifierScore * 100)}</span>
              ) : null}
              {classifierLabel ? <span>label · {classifierLabel}</span> : null}
              {trigger ? <span>trigger · {trigger}</span> : null}
              {!followerLabel &&
              !tier &&
              classifierScore == null &&
              !classifierLabel &&
              !trigger ? (
                <span>classifier signals not synced</span>
              ) : null}
            </div>
          </div>

          {/* Context loaded — the voice anchors the drafter pulled from your
              local knowledge base to ground this lead's replies + DM. */}
          <div className="card">
            <div className="eyebrow">Context loaded</div>
            <div
              style={{
                marginTop: 10,
                display: "flex",
                flexDirection: "column",
                gap: 6,
              }}
            >
              {trigger ? (
                <div
                  style={{
                    fontFamily: "var(--mono)",
                    fontSize: 11.5,
                    padding: "6px 8px",
                    background: "var(--paper-2)",
                    borderRadius: 6,
                    color: "var(--ink-2)",
                  }}
                >
                  <span style={{ color: "var(--accent)" }}>◆</span> matched:{" "}
                  {trigger}
                </div>
              ) : null}
              {anchors.length > 0 ? (
                anchors.map((a, i) => (
                  <div
                    key={i}
                    style={{
                      fontSize: 12,
                      padding: "8px 10px",
                      background: "var(--paper-2)",
                      borderRadius: 6,
                      color: "var(--ink-2)",
                      lineHeight: 1.45,
                    }}
                  >
                    <span
                      style={{
                        fontFamily: "var(--mono)",
                        fontSize: 10.5,
                        color: "var(--ink-muted)",
                      }}
                    >
                      anchor {i + 1} · {a.score.toFixed(1)}
                    </span>
                    <div style={{ marginTop: 3 }}>{a.snippet}</div>
                  </div>
                ))
              ) : (
                <div
                  style={{
                    fontSize: 12,
                    padding: "6px 8px",
                    color: "var(--ink-muted)",
                  }}
                >
                  No vault anchors recorded for this lead (drafted from general
                  voice, or before anchor capture).
                </div>
              )}
            </div>
          </div>

          {/* Classifier — one compact line (score · label · tier · status). */}
          <div className="card">
            <div className="eyebrow">Classifier</div>
            <div
              style={{
                marginTop: 8,
                display: "flex",
                alignItems: "center",
                gap: 8,
                flexWrap: "wrap",
                fontFamily: "var(--mono)",
                fontSize: 12,
                color: "var(--ink-2)",
              }}
            >
              <span
                style={{
                  color:
                    classifierScore == null
                      ? "var(--ink-muted)"
                      : classifierScore >= 0.75
                        ? "var(--accent)"
                        : classifierScore >= 0.5
                          ? "var(--ink-2)"
                          : "var(--ink-muted)",
                }}
              >
                {classifierScore != null ? `${Math.round(classifierScore * 100)}/100` : "—"}
              </span>
              <span style={{ color: "var(--ink-muted)" }}>·</span>
              <span>{classifierLabel ?? "—"}</span>
              <span style={{ color: "var(--ink-muted)" }}>·</span>
              <span>{tier ?? "—"}</span>
              <span style={{ color: "var(--ink-muted)" }}>·</span>
              <span style={{ color: "var(--ink-muted)" }}>
                {classifierKnown ? "synced" : "pending"}
              </span>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}

function ActionedBanner({
  status,
  postedUrl,
  skipReason,
  decidedAt,
  angles,
  isDM,
  dmBody,
}: {
  status: string;
  postedUrl: string | null;
  skipReason: string | null;
  decidedAt: string | null;
  angles: ReturnType<typeof buildAngles>;
  isDM: boolean;
  dmBody: string;
}) {
  const label =
    status === "sent" && postedUrl
      ? "Posted to X"
      : status === "sent"
        ? isDM
          ? "Sent as a DM"
          : "Approved — send worker pending"
        : status === "skipped"
          ? skipReason === "sibling-angle-sent"
            ? "Skipped (another angle was sent)"
            : "Skipped"
          : status === "errored"
            ? "Send failed"
            : `Status: ${status}`;

  const tone =
    status === "sent"
      ? "var(--accent)"
      : status === "errored"
        ? "var(--danger)"
        : "var(--ink-muted)";

  return (
    <div>
      <div className="eyebrow" style={{ marginBottom: 12 }}>
        Resolved {decidedAt ? timeAgo(decidedAt) : ""}
      </div>
      <div
        className="card"
        style={{
          padding: 18,
          borderColor: tone,
          boxShadow: `0 0 0 0.5px color-mix(in oklch, ${tone} 40%, var(--rule))`,
          marginBottom: 18,
        }}
      >
        <div
          style={{
            fontFamily: "var(--display)",
            fontSize: 18,
            color: tone,
            marginBottom: 6,
          }}
        >
          {label}
        </div>
        {postedUrl ? (
          <a
            href={postedUrl}
            target="_blank"
            rel="noreferrer"
            style={{
              fontFamily: "var(--mono)",
              fontSize: 12,
              color: "var(--accent)",
              textDecoration: "none",
              wordBreak: "break-all",
            }}
          >
            {postedUrl} ↗
          </a>
        ) : status === "errored" && skipReason ? (
          <div
            style={{
              fontFamily: "var(--mono)",
              fontSize: 12,
              color: "var(--ink-2)",
              whiteSpace: "pre-wrap",
            }}
          >
            {skipReason}
          </div>
        ) : null}
      </div>

      {/* Show the (historical) draft body so the reviewer remembers what they approved. */}
      <div className="angle-stack" style={{ opacity: 0.7 }}>
        {isDM ? (
          <div className="angle">
            <h4>
              <span className="num">DM</span>
              <span>Direct message</span>
            </h4>
            <div className="text" style={{ whiteSpace: "pre-wrap" }}>
              {dmBody}
            </div>
          </div>
        ) : (
          angles.map((a, i) => (
            <div key={a.id} className="angle">
              <h4>
                <span className="num">0{i + 1}</span>
                <span>{a.kind}</span>
              </h4>
              <div className="text">{a.text}</div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
