import type { ReactNode } from "react";
import { SlidersHorizontal } from "lucide-react";
import { QueryFilter, type QueryFilterOption } from "./QueryFilter";
import { ScoreFilter } from "./ScoreFilter";
import styles from "./query-filter.module.css";

type Platform = "x" | "linkedin" | "reddit";
interface FilterDefinition {
  param: string;
  label: string;
  defaultValue: string;
  options: QueryFilterOption[];
}

const status: FilterDefinition = {
  param: "status", label: "Status", defaultValue: "pending",
  options: [
    { value: "pending", label: "Pending" }, { value: "sent", label: "Sent" },
    { value: "skipped", label: "Skipped" }, { value: "all", label: "All" },
  ],
};
const source: FilterDefinition = {
  param: "source", label: "Source", defaultValue: "real",
  options: [{ value: "real", label: "Real" }, { value: "synthetic", label: "Test/synthetic" }, { value: "all", label: "All" }],
};
const watchlist: FilterDefinition = {
  param: "watchlist", label: "Watchlist", defaultValue: "all",
  options: [{ value: "all", label: "All" }, { value: "only", label: "Watchlist only" }, { value: "exclude", label: "Exclude watchlist" }],
};
const perPerson: FilterDefinition = {
  param: "wlLatest", label: "Per person", defaultValue: "off",
  options: [{ value: "off", label: "All posts" }, { value: "on", label: "Latest only" }],
};
const batch: FilterDefinition = {
  param: "batch", label: "Batch", defaultValue: "all",
  options: [{ value: "all", label: "All" }, { value: "last", label: "Last batch" }],
};
const sortByScore: FilterDefinition = {
  param: "sort", label: "Sort", defaultValue: "score",
  options: [{ value: "score", label: "Top score" }, { value: "newest_post", label: "Newest post" }],
};
const sortByDate: FilterDefinition = {
  param: "sort", label: "Sort", defaultValue: "newest_post",
  options: [{ value: "newest_post", label: "Newest" }, { value: "oldest", label: "Oldest" }],
};
const FILTERS: Record<Platform, FilterDefinition[]> = {
  x: [status, source, watchlist, perPerson, sortByScore, batch],
  linkedin: [status, watchlist, perPerson, sortByDate, batch],
  reddit: [status, sortByDate, batch],
};

export function ApprovalFilters({ platform, basePath, children }: { platform: Platform; basePath: string; children?: ReactNode }) {
  return (
    <section className={styles.toolbar} aria-label="Filter approval queue">
      <span className={styles.toolbarTitle}><SlidersHorizontal size={16} aria-hidden="true" /> Filters</span>
      <div className={styles.fields}>
        {FILTERS[platform].map((filter) => (
          <QueryFilter key={filter.param} basePath={basePath} {...filter} />
        ))}
        {platform === "x" ? <ScoreFilter basePath={basePath} /> : null}
      </div>
      {children ? <div className={styles.notes}>{children}</div> : null}
    </section>
  );
}
