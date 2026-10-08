import type {
  ApprovalSort,
  ApprovalSourceFilter,
  ApprovalStatusFilter,
  ApprovalWatchlistFilter,
} from "@/lib/queries";

/**
 * Shared parse/serialize for the approvals queue filters (?minScore/?status/
 * ?source/?watchlist/?sort/?batch). Both the queue list page and the
 * single-approval detail page use this so the detail page's "Lead N of M"
 * stepper walks the SAME set the reviewer filtered to — and so the filter
 * survives every prev/next hop.
 */

export const STATUS_FILTERS: ApprovalStatusFilter[] = [
  "pending",
  "sent",
  "skipped",
  "all",
];
export const SOURCE_FILTERS: ApprovalSourceFilter[] = [
  "real",
  "synthetic",
  "all",
];
export const WATCHLIST_FILTERS: ApprovalWatchlistFilter[] = [
  "all",
  "only",
  "exclude",
];
export const SORT_FILTERS: ApprovalSort[] = ["score", "newest_post"];
/** "all" = no batch filter; "last" = only the most recent goal-run's output. */
export const BATCH_FILTERS = ["all", "last"] as const;
export type ApprovalBatchFilter = (typeof BATCH_FILTERS)[number];

export interface ApprovalFilterParams {
  minScore?: string;
  status?: string;
  source?: string;
  watchlist?: string;
  sort?: string;
  batch?: string;
  wlLatest?: string;
}

export interface ApprovalFilters {
  minScore: number | null;
  status: ApprovalStatusFilter;
  source: ApprovalSourceFilter;
  watchlist: ApprovalWatchlistFilter;
  sort: ApprovalSort;
  batch: ApprovalBatchFilter;
  /**
   * "Latest post per watchlisted person." When true, each watched author
   * (leads.priority = true) is collapsed to just their newest post so a chatty
   * connection doesn't fill the queue. Off by default; non-watchlisted leads are
   * never affected. Serialized as `?wlLatest=on`.
   */
  latestPerWatchlisted: boolean;
}

/**
 * Parse + validate the queue filters from URL search params. Invalid values
 * fall back to the server-side defaults (pending / real / all / score / all-batch
 * / no floor). minScore is the raw finite number — listPendingApprovalsForOrg
 * clamps it to [0,1].
 */
export function parseApprovalFilters(sp: ApprovalFilterParams): ApprovalFilters {
  const parsed =
    sp.minScore != null && sp.minScore !== "" ? Number(sp.minScore) : null;
  const minScore = parsed != null && Number.isFinite(parsed) ? parsed : null;
  const status = STATUS_FILTERS.includes(sp.status as ApprovalStatusFilter)
    ? (sp.status as ApprovalStatusFilter)
    : "pending";
  const source = SOURCE_FILTERS.includes(sp.source as ApprovalSourceFilter)
    ? (sp.source as ApprovalSourceFilter)
    : "real";
  const watchlist = WATCHLIST_FILTERS.includes(
    sp.watchlist as ApprovalWatchlistFilter,
  )
    ? (sp.watchlist as ApprovalWatchlistFilter)
    : "all";
  const sort = SORT_FILTERS.includes(sp.sort as ApprovalSort)
    ? (sp.sort as ApprovalSort)
    : "score";
  const batch = BATCH_FILTERS.includes(sp.batch as ApprovalBatchFilter)
    ? (sp.batch as ApprovalBatchFilter)
    : "all";
  const latestPerWatchlisted = sp.wlLatest === "on";
  return { minScore, status, source, watchlist, sort, batch, latestPerWatchlisted };
}

/**
 * Serialize only the NON-DEFAULT filters into a URL query suffix (including the
 * leading "?"), or "" when everything is default — so default views keep clean
 * URLs. The detail page reads these back with parseApprovalFilters.
 */
export function approvalFilterQuery(f: ApprovalFilters): string {
  const p = new URLSearchParams();
  if (f.minScore != null) p.set("minScore", String(f.minScore));
  if (f.status !== "pending") p.set("status", f.status);
  if (f.source !== "real") p.set("source", f.source);
  if (f.watchlist !== "all") p.set("watchlist", f.watchlist);
  if (f.sort !== "score") p.set("sort", f.sort);
  if (f.batch !== "all") p.set("batch", f.batch);
  if (f.latestPerWatchlisted) p.set("wlLatest", "on");
  const s = p.toString();
  return s ? `?${s}` : "";
}

// ---------------------------------------------------------------------------
// LinkedIn (Lyra) approvals filters — a reduced sibling of the X filters above.
// Lyra has no classifier (so no minScore/score-sort) and no synthetic seed
// leads (so no source filter), but status/watchlist/sort/batch all apply. Kept
// SEPARATE from the X parse so the X detail-stepper path is never touched.
// ---------------------------------------------------------------------------

/** LinkedIn sort axes — no `score` (no classifier). Default newest post first. */
export const LINKEDIN_SORT_FILTERS = ["newest_post", "oldest"] as const;
export type LinkedInApprovalSort = (typeof LINKEDIN_SORT_FILTERS)[number];

export interface LinkedInApprovalFilters {
  status: ApprovalStatusFilter;
  /** all / only / exclude — keyed off lead.priority (watched connection). A
   *  no-op today since every LinkedIn lead is a watched connection, but ready
   *  for when non-watchlist LinkedIn leads land. */
  watchlist: ApprovalWatchlistFilter;
  sort: LinkedInApprovalSort;
  batch: ApprovalBatchFilter;
  /**
   * "Latest post per person" — collapse each connection to just their newest
   * post. Mirrors the X-side filter so Lyra's Review list, Speedrun, AND the
   * detail-page stepper all walk the same one-per-person set. Serialized as
   * `?wlLatest=on`. Off by default. (Every Lyra lead is a watched connection,
   * so this effectively collapses the whole list.)
   */
  latestPerWatchlisted: boolean;
}

export function parseLinkedInApprovalFilters(
  sp: ApprovalFilterParams,
): LinkedInApprovalFilters {
  const status = STATUS_FILTERS.includes(sp.status as ApprovalStatusFilter)
    ? (sp.status as ApprovalStatusFilter)
    : "pending";
  const watchlist = WATCHLIST_FILTERS.includes(
    sp.watchlist as ApprovalWatchlistFilter,
  )
    ? (sp.watchlist as ApprovalWatchlistFilter)
    : "all";
  const sort = (LINKEDIN_SORT_FILTERS as readonly string[]).includes(
    sp.sort ?? "",
  )
    ? (sp.sort as LinkedInApprovalSort)
    : "newest_post";
  const batch = BATCH_FILTERS.includes(sp.batch as ApprovalBatchFilter)
    ? (sp.batch as ApprovalBatchFilter)
    : "all";
  const latestPerWatchlisted = sp.wlLatest === "on";
  return { status, watchlist, sort, batch, latestPerWatchlisted };
}

/** Serialize only non-default LinkedIn filters into a `?...` suffix (or ""). */
export function linkedInApprovalFilterQuery(f: LinkedInApprovalFilters): string {
  const p = new URLSearchParams();
  if (f.status !== "pending") p.set("status", f.status);
  if (f.watchlist !== "all") p.set("watchlist", f.watchlist);
  if (f.sort !== "newest_post") p.set("sort", f.sort);
  if (f.batch !== "all") p.set("batch", f.batch);
  if (f.latestPerWatchlisted) p.set("wlLatest", "on");
  const s = p.toString();
  return s ? `?${s}` : "";
}

/**
 * True when any filter is off its default and therefore NARROWS the pending
 * list (watchlist / min-score / source / last-batch / latest-per-person).
 * `status` is the view selector (pending vs sent/skipped/all), not a within-view
 * narrowing filter, so it's excluded; `sort` only reorders, so it's excluded too.
 *
 * Drives the "no matches — clear filters" empty state: when this is true and
 * the rendered list is empty while the unfiltered backlog is not, the inbox is
 * filtered-empty (a filter hid the work), NOT idle (the intern produced none).
 * Conflating the two is the "Watchlist only shows 0 so the intern looks broken"
 * bug.
 */
export function hasActiveFilter(f: ApprovalFilters): boolean {
  return (
    f.watchlist !== "all" ||
    f.minScore != null ||
    f.source !== "real" ||
    f.batch === "last" ||
    f.latestPerWatchlisted
  );
}
