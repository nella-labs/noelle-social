import { describe, expect, it } from "vitest";
import {
  parseApprovalFilters,
  approvalFilterQuery,
  parseLinkedInApprovalFilters,
  linkedInApprovalFilterQuery,
  hasActiveFilter,
} from "./approval-filters.js";

const DEFAULTS = {
  minScore: null,
  status: "pending",
  source: "real",
  watchlist: "all",
  sort: "score",
  batch: "all",
  latestPerWatchlisted: false,
} as const;

describe("parseApprovalFilters", () => {
  it("defaults to pending / real / all-watchlist / score / all-batch / no floor when params are absent", () => {
    expect(parseApprovalFilters({})).toEqual({
      minScore: null,
      status: "pending",
      source: "real",
      watchlist: "all",
      sort: "score",
      batch: "all",
      latestPerWatchlisted: false,
    });
  });

  it("accepts valid filters", () => {
    expect(
      parseApprovalFilters({
        minScore: "0.7",
        status: "sent",
        source: "all",
        watchlist: "only",
        sort: "newest_post",
        batch: "last",
        wlLatest: "on",
      }),
    ).toEqual({
      minScore: 0.7,
      status: "sent",
      source: "all",
      watchlist: "only",
      sort: "newest_post",
      batch: "last",
      latestPerWatchlisted: true,
    });
  });

  it("treats any wlLatest value other than 'on' as off", () => {
    expect(parseApprovalFilters({ wlLatest: "1" }).latestPerWatchlisted).toBe(false);
    expect(parseApprovalFilters({ wlLatest: "true" }).latestPerWatchlisted).toBe(false);
    expect(parseApprovalFilters({ wlLatest: "" }).latestPerWatchlisted).toBe(false);
    expect(parseApprovalFilters({ wlLatest: "on" }).latestPerWatchlisted).toBe(true);
  });

  it("falls back to defaults for invalid status/source/watchlist/sort/batch", () => {
    expect(
      parseApprovalFilters({
        status: "bogus",
        source: "nope",
        watchlist: "huh",
        sort: "x",
        batch: "y",
      }),
    ).toEqual({
      minScore: null,
      status: "pending",
      source: "real",
      watchlist: "all",
      sort: "score",
      batch: "all",
      latestPerWatchlisted: false,
    });
  });

  it("treats empty / non-numeric minScore as no floor", () => {
    expect(parseApprovalFilters({ minScore: "" }).minScore).toBeNull();
    expect(parseApprovalFilters({ minScore: "abc" }).minScore).toBeNull();
  });
});

describe("approvalFilterQuery", () => {
  it("is empty when all filters are default", () => {
    expect(
      approvalFilterQuery({
        minScore: null,
        status: "pending",
        source: "real",
        watchlist: "all",
        sort: "score",
        batch: "all",
        latestPerWatchlisted: false,
      }),
    ).toBe("");
  });

  it("serializes only the non-default filters, with a leading ?", () => {
    expect(
      approvalFilterQuery({
        minScore: 0.7,
        status: "sent",
        source: "all",
        watchlist: "exclude",
        sort: "newest_post",
        batch: "last",
        latestPerWatchlisted: true,
      }),
    ).toBe(
      "?minScore=0.7&status=sent&source=all&watchlist=exclude&sort=newest_post&batch=last&wlLatest=on",
    );
  });

  it("omits defaults but keeps the one that changed", () => {
    expect(
      approvalFilterQuery({
        minScore: null,
        status: "pending",
        source: "synthetic",
        watchlist: "all",
        sort: "score",
        batch: "all",
        latestPerWatchlisted: false,
      }),
    ).toBe("?source=synthetic");
  });

  it("serializes the watchlist filter on its own", () => {
    expect(
      approvalFilterQuery({
        minScore: null,
        status: "pending",
        source: "real",
        watchlist: "only",
        sort: "score",
        batch: "all",
        latestPerWatchlisted: false,
      }),
    ).toBe("?watchlist=only");
  });

  it("serializes the latest-per-person filter on its own", () => {
    expect(
      approvalFilterQuery({
        minScore: null,
        status: "pending",
        source: "real",
        watchlist: "all",
        sort: "score",
        batch: "all",
        latestPerWatchlisted: true,
      }),
    ).toBe("?wlLatest=on");
  });

  it("round-trips through parseApprovalFilters", () => {
    const f = {
      minScore: 0.5,
      status: "all" as const,
      source: "all" as const,
      watchlist: "only" as const,
      sort: "newest_post" as const,
      batch: "last" as const,
      latestPerWatchlisted: true,
    };
    const sp = new URLSearchParams(approvalFilterQuery(f).slice(1));
    expect(
      parseApprovalFilters({
        minScore: sp.get("minScore") ?? undefined,
        status: sp.get("status") ?? undefined,
        source: sp.get("source") ?? undefined,
        watchlist: sp.get("watchlist") ?? undefined,
        sort: sp.get("sort") ?? undefined,
        batch: sp.get("batch") ?? undefined,
        wlLatest: sp.get("wlLatest") ?? undefined,
      }),
    ).toEqual(f);
  });
});

describe("parseLinkedInApprovalFilters", () => {
  it("defaults to pending / all-watchlist / newest_post / all-batch / no per-person collapse", () => {
    expect(parseLinkedInApprovalFilters({})).toEqual({
      status: "pending",
      watchlist: "all",
      sort: "newest_post",
      batch: "all",
      latestPerWatchlisted: false,
    });
  });

  it("accepts valid filters including wlLatest", () => {
    expect(
      parseLinkedInApprovalFilters({
        status: "sent",
        watchlist: "only",
        sort: "oldest",
        batch: "last",
        wlLatest: "on",
      }),
    ).toEqual({
      status: "sent",
      watchlist: "only",
      sort: "oldest",
      batch: "last",
      latestPerWatchlisted: true,
    });
  });

  it("treats any wlLatest value other than 'on' as off", () => {
    expect(parseLinkedInApprovalFilters({ wlLatest: "1" }).latestPerWatchlisted).toBe(false);
    expect(parseLinkedInApprovalFilters({ wlLatest: "on" }).latestPerWatchlisted).toBe(true);
  });

  it("ignores the X-only score sort (no classifier on LinkedIn)", () => {
    expect(parseLinkedInApprovalFilters({ sort: "score" }).sort).toBe("newest_post");
  });
});

describe("linkedInApprovalFilterQuery", () => {
  const base = {
    status: "pending" as const,
    watchlist: "all" as const,
    sort: "newest_post" as const,
    batch: "all" as const,
    latestPerWatchlisted: false,
  };

  it("is empty when all filters are default", () => {
    expect(linkedInApprovalFilterQuery(base)).toBe("");
  });

  it("serializes the per-person filter on its own", () => {
    expect(
      linkedInApprovalFilterQuery({ ...base, latestPerWatchlisted: true }),
    ).toBe("?wlLatest=on");
  });

  it("round-trips through parseLinkedInApprovalFilters", () => {
    const f = {
      status: "sent" as const,
      watchlist: "only" as const,
      sort: "oldest" as const,
      batch: "last" as const,
      latestPerWatchlisted: true,
    };
    const sp = new URLSearchParams(linkedInApprovalFilterQuery(f).slice(1));
    expect(
      parseLinkedInApprovalFilters({
        status: sp.get("status") ?? undefined,
        watchlist: sp.get("watchlist") ?? undefined,
        sort: sp.get("sort") ?? undefined,
        batch: sp.get("batch") ?? undefined,
        wlLatest: sp.get("wlLatest") ?? undefined,
      }),
    ).toEqual(f);
  });
});

describe("hasActiveFilter", () => {
  it("is false when every filter is at its default", () => {
    expect(hasActiveFilter({ ...DEFAULTS })).toBe(false);
  });

  it("is true for a watchlist filter (the reported case: Watchlist only)", () => {
    expect(hasActiveFilter({ ...DEFAULTS, watchlist: "only" })).toBe(true);
    expect(hasActiveFilter({ ...DEFAULTS, watchlist: "exclude" })).toBe(true);
  });

  it("is true for a min-score floor, a non-real source, or last-batch", () => {
    expect(hasActiveFilter({ ...DEFAULTS, minScore: 0.5 })).toBe(true);
    expect(hasActiveFilter({ ...DEFAULTS, source: "synthetic" })).toBe(true);
    expect(hasActiveFilter({ ...DEFAULTS, source: "all" })).toBe(true);
    expect(hasActiveFilter({ ...DEFAULTS, batch: "last" })).toBe(true);
  });

  it("is true for the latest-per-person collapse (narrows the list)", () => {
    expect(hasActiveFilter({ ...DEFAULTS, latestPerWatchlisted: true })).toBe(
      true,
    );
  });

  it("ignores status and sort — they pick the view/order, they don't narrow", () => {
    expect(hasActiveFilter({ ...DEFAULTS, status: "sent" })).toBe(false);
    expect(hasActiveFilter({ ...DEFAULTS, status: "all" })).toBe(false);
    expect(hasActiveFilter({ ...DEFAULTS, sort: "newest_post" })).toBe(false);
  });
});
