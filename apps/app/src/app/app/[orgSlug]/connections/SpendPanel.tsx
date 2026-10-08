import Link from "next/link";
import {
  getOrgBudgetCapCents,
  getOrgSpendByBucketRange,
  getOrgSpendByWorkerRange,
  getOrgSpendTrendRange,
  getApifyProviderSpend,
  isApifyBucket,
  loadXApiSpend,
  resolveSpendRange,
  type SpendRangeKey,
} from "@/lib/queries";
import { formatCents } from "@/lib/utils";
import { SpendTrendChart } from "@/components/spend/SpendTrendChart";
import styles from "@/components/spend/spend.module.css";

interface SpendPanelProps {
  orgId: string;
  orgSlug: string;
  rangeParam?: string;
}

function monthShortNow(): string {
  return new Intl.DateTimeFormat("en-US", { month: "short", timeZone: "UTC" }).format(new Date());
}

function daysRemainingThisMonth(): number {
  const now = new Date();
  const total = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).getUTCDate();
  return Math.max(0, total - now.getUTCDate());
}

function totalDaysThisMonth(): number {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).getUTCDate();
}

function formatFetchedAt(iso: string | null): string {
  if (!iso) return "Not fetched";
  return `Last fetched ${new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: "UTC",
    timeZoneName: "short",
  }).format(new Date(iso))}`;
}

/** Friendlier worker labels for the "By worker" chart. */
const WORKER_LABEL: Record<string, string> = {
  drafter: "Drafter",
  classifier: "Classifier",
  discovery: "Discovery",
  profiler: "Profiler",
  send: "Send",
  feeder: "Account Feeder",
  ideation: "Ideation",
  followup: "Follow-up",
  other: "Other",
};

const RANGE_TABS: { key: SpendRangeKey; short: string }[] = [
  { key: "month", short: "Month" },
  { key: "quarter", short: "Quarter" },
  { key: "year", short: "Year" },
  { key: "all", short: "All time" },
];

export async function SpendPanel({ orgId, orgSlug, rangeParam }: SpendPanelProps) {
  const range = resolveSpendRange(rangeParam);
  const isMonth = range.key === "month";

  const [bucketRows, capCents, byWorker, trend, apifyProvider, xapi] = await Promise.all([
    getOrgSpendByBucketRange(orgId, range.startIso),
    getOrgBudgetCapCents(orgId),
    getOrgSpendByWorkerRange(orgId, range.startIso),
    getOrgSpendTrendRange(orgId, range.startIso, range.granularity),
    getApifyProviderSpend(orgId, range.startIso),
    loadXApiSpend(orgId),
  ]);

  const monthShort = monthShortNow();
  const daysRemaining = daysRemainingThisMonth();
  const totalDaysInMonth = totalDaysThisMonth();

  // Split buckets: LLM buckets count toward the cap; Apify buckets (apify-<worker>)
  // are recorded for visibility but NEVER count toward the limit.
  const allBuckets = [...bucketRows]
    .map((r) => ({ id: r.bucket, label: r.bucket, cents: r.cents ?? 0 }))
    .sort((a, b) => b.cents - a.cents);
  const llmBuckets = allBuckets.filter((b) => !isApifyBucket(b.label));

  const totalCents = llmBuckets.reduce((acc, b) => acc + b.cents, 0);
  const apifyCents = apifyProvider.cents;
  const apifyUnverifiedCents = apifyProvider.unverifiedCents;
  const hasApifyProviderFetch = apifyProvider.fetchedAt !== null;
  const apifyProviderAmount = hasApifyProviderFetch ? formatCents(apifyCents) : "Not fetched";
  const hasCap = capCents > 0;
  const pctOfCap = hasCap ? Math.min(100, (totalCents / capCents) * 100) : 0;

  const maxBucketCents = Math.max(1, ...llmBuckets.map((b) => b.cents));

  const providerApifyByBucket = new Map<string, number>();
  for (const row of apifyProvider.byDay) {
    const key = range.granularity === "month" ? row.day.slice(0, 7) : row.day;
    providerApifyByBucket.set(key, (providerApifyByBucket.get(key) ?? 0) + row.cents);
  }
  const trendByBucket = new Map<string, (typeof trend)[number]>();
  for (const d of trend) trendByBucket.set(d.day, { ...d, apifyCents: 0 });
  for (const [day, cents] of providerApifyByBucket) {
    const current = trendByBucket.get(day);
    trendByBucket.set(
      day,
      current ? { ...current, apifyCents: cents } : { day, llmCents: 0, apifyCents: cents },
    );
  }
  const providerTrend = [...trendByBucket.values()].sort((a, b) => a.day.localeCompare(b.day));
  const trendMax = Math.max(1, ...providerTrend.map((d) => d.llmCents + d.apifyCents));
  const trendTotalLlm = providerTrend.reduce((a, d) => a + d.llmCents, 0);
  const trendTotalApify = providerTrend.reduce((a, d) => a + d.apifyCents, 0);
  const perUnit = range.granularity === "day" ? "day" : "mo";
  const avgUnitLlm = Math.round(trendTotalLlm / Math.max(1, providerTrend.length));

  const workerRows = byWorker
    .map((w) => ({ ...w, label: WORKER_LABEL[w.worker] ?? w.worker, total: w.llmCents }))
    .filter((w) => w.total > 0);
  const maxWorkerCents = Math.max(1, ...workerRows.map((w) => w.total));

  const isEmpty =
    llmBuckets.length === 0 && totalCents === 0 && apifyCents === 0 && apifyUnverifiedCents === 0;

  const emptyNote = range.key === "all" ? "yet" : `${range.label.toLowerCase()} yet`;

  return (
    <div className={styles.spend}>
      {/* Range selector */}
      <div
        className="seg"
        role="tablist"
        aria-label="Spend time range"
        style={{ marginBottom: 24 }}
      >
        {RANGE_TABS.map((t) => {
          const active = t.key === range.key;
          const href =
            t.key === "month"
              ? `/app/${orgSlug}/connections?tab=spend`
              : `/app/${orgSlug}/connections?tab=spend&range=${t.key}`;
          return (
            <Link
              key={t.key}
              href={href}
              role="tab"
              aria-selected={active}
              className={`seg__btn${active ? " is-active" : ""}`}
            >
              {t.short}
            </Link>
          );
        })}
      </div>

      {/* Top row: range total · burn trend */}
      <div className={styles.summaryGrid}>
        <div className={`card ${styles.totalCard}`}>
          <div className="card-h">
            <h3>{range.label}</h3>
            {isMonth && hasCap ? (
              <span className="tag">{Math.round(pctOfCap)}% of cap</span>
            ) : isMonth ? (
              <span className="tag">no cap configured</span>
            ) : (
              <span className="tag">LLM total</span>
            )}
          </div>
          <div style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap" }}>
            <span className="serif spend-hero">{formatCents(totalCents)}</span>
            {isMonth && hasCap ? (
              <span style={{ color: "var(--ink-muted)" }}>/ {formatCents(capCents)}</span>
            ) : null}
          </div>

          {isMonth ? (
            <>
              <div className="bar-track" style={{ height: 10, marginTop: 16 }}>
                <div className="bar-fill acc" style={{ width: hasCap ? `${pctOfCap}%` : "0%" }} />
              </div>
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  marginTop: 6,
                  fontFamily: "var(--mono)",
                  fontSize: 11,
                  color: "var(--ink-muted)",
                }}
              >
                <span>1 {monthShort}</span>
                <span>
