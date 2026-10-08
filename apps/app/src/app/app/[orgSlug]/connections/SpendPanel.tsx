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
                  {daysRemaining} day{daysRemaining === 1 ? "" : "s"} remaining
                </span>
                <span>
                  {totalDaysInMonth} {monthShort}
                </span>
              </div>
            </>
          ) : (
            <div style={{ marginTop: 12, fontSize: 12.5, color: "var(--ink-muted)" }}>
              LLM spend counting toward per-month caps, summed across {range.label.toLowerCase()}.
              The cap is a monthly guardrail — switch to <strong>Month</strong> to see cap progress.
            </div>
          )}

          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "baseline",
              marginTop: 14,
              paddingTop: 12,
              borderTop: "1px dashed var(--rule-soft)",
              fontSize: 12.5,
              color: "var(--ink-muted)",
            }}
          >
            <span>
              Apify provider usage · <strong>not counted toward limit</strong>
            </span>
            <span style={{ fontFamily: "var(--mono)" }}>{apifyProviderAmount}</span>
          </div>
          <div style={{ marginTop: 6, fontSize: 11.5, color: "var(--ink-muted)" }}>
            {formatFetchedAt(apifyProvider.fetchedAt)}
            {isMonth ? " · Calendar month; token billing cycles may reset on a different day." : ""}
          </div>
          {apifyUnverifiedCents > 0 ? (
            <div style={{ marginTop: 6, fontSize: 11.5, color: "var(--ink-muted)" }}>
              {formatCents(apifyUnverifiedCents)} in unverified Apify run charges remains
              visible but is not added to reported provider usage.
            </div>
          ) : null}
        </div>

        <div className="card">
          <div className="card-h">
            <h3>{range.granularity === "day" ? "Daily burn" : "Monthly burn"}</h3>
            <span className="tag">
              avg {formatCents(avgUnitLlm)}/{perUnit} LLM
            </span>
          </div>
          <SpendTrendChart points={providerTrend} max={trendMax} rangeLabel={range.label} apifyAvailable={hasApifyProviderFetch} />
          <div
            style={{
              display: "flex",
              gap: 16,
              marginTop: 10,
              fontSize: 11,
              color: "var(--ink-muted)",
            }}
          >
            <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
              <span style={{ width: 9, height: 9, borderRadius: 2, background: "var(--accent)" }} />
              LLM · {formatCents(trendTotalLlm)}
            </span>
            <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
              <span style={{ width: 9, height: 9, borderRadius: 2, background: "var(--ok)" }} />
              Apify · {hasApifyProviderFetch ? formatCents(trendTotalApify) : "Not fetched"}
            </span>
          </div>
        </div>
      </div>

      <div className={styles.breakdowns}>
      {/* By worker — provider Apify is account-level, so worker attribution stays LLM-only. */}
      <div className={`card ${styles.breakdownCard}`}>
        <div className="card-h">
          <h3>By worker</h3>
          <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
            <span
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 5,
                fontSize: 11,
                color: "var(--ink-muted)",
              }}
            >
              <span style={{ width: 9, height: 9, borderRadius: 2, background: "var(--accent)" }} />{" "}
              LLM
            </span>
          </div>
        </div>

        {workerRows.length === 0 ? (
          <div style={{ padding: "20px 0 4px", color: "var(--ink-muted)", fontSize: 13 }}>
            No LLM spend recorded {emptyNote}. Bars fill in as each worker logs model calls.
          </div>
        ) : (
          workerRows.map((w, i) => {
            const llmPct = (w.llmCents / maxWorkerCents) * 100;
            return (
              <div
                key={w.worker}
                className="stack-phone"
                style={{
                  display: "grid",
                  gridTemplateColumns: "1fr 110px",
                  gap: 16,
                  alignItems: "center",
                  padding: "14px 0",
                  borderTop: i === 0 ? 0 : "1px dashed var(--rule-soft)",
                }}
              >
                <div>
                  <div
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      flexWrap: "wrap",
                      gap: 8,
                    }}
                  >
                    <span style={{ fontWeight: 500 }}>{w.label}</span>
                  </div>
                  <div className="bar-track" style={{ marginTop: 8, display: "flex" }}>
                    <div
                      className="bar-fill acc"
                      style={{
                        position: "relative",
                        width: `${Math.max(llmPct, w.llmCents > 0 ? 1.5 : 0)}%`,
                      }}
                    />
                  </div>
                </div>
                <div style={{ textAlign: "right", fontFamily: "var(--mono)", fontSize: 13 }}>
                  {formatCents(w.total)}
                </div>
              </div>
            );
          })
        )}
      </div>

      {/* Buckets — LLM pools that count toward the cap */}
      <div className="card">
        <div className="card-h">
          <h3>Buckets · counts toward cap</h3>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <span className="tag">
              {llmBuckets.length} pool{llmBuckets.length === 1 ? "" : "s"}
            </span>
            <button type="button" className="btn btn-sm btn-ghost" disabled>
              Adjust caps →
            </button>
          </div>
        </div>

        {isEmpty ? (
          <div style={{ padding: "20px 0 4px", color: "var(--ink-muted)", fontSize: 13 }}>
            No spend recorded {emptyNote}. Buckets fill in as your agents log LLM calls.
          </div>
        ) : llmBuckets.length === 0 ? (
          <div style={{ padding: "20px 0 4px", color: "var(--ink-muted)", fontSize: 13 }}>
            No LLM spend {emptyNote} — only Apify provider usage, which doesn&apos;t count toward
            your cap (see {formatCents(apifyCents)} below).
          </div>
        ) : (
          llmBuckets.map((b, i) => {
            const widthPct = (b.cents / maxBucketCents) * 100;
            const pctOfTotal = totalCents === 0 ? 0 : (b.cents / totalCents) * 100;
            const tone =
              b.cents >= maxBucketCents * 0.85
                ? "acc"
                : b.cents >= maxBucketCents * 0.45
                  ? "ok"
                  : "";
            return (
              <div
                key={b.id}
                className="stack-phone"
                style={{
                  display: "grid",
                  gridTemplateColumns: "1fr 110px 90px",
                  gap: 16,
                  alignItems: "center",
                  padding: "14px 0",
                  borderTop: i === 0 ? 0 : "1px dashed var(--rule-soft)",
                }}
              >
                <div>
                  <div style={{ fontWeight: 500 }}>{b.label}</div>
                  <div className="bar-track" style={{ marginTop: 8 }}>
                    <div
                      className={`bar-fill${tone ? ` ${tone}` : ""}`}
                      style={{ width: `${Math.max(widthPct, 1.5)}%` }}
                    />
                  </div>
                </div>
                <div style={{ textAlign: "right", fontFamily: "var(--mono)", fontSize: 13 }}>
                  {formatCents(b.cents)}
                </div>
                <div
                  style={{
                    textAlign: "right",
                    fontFamily: "var(--mono)",
                    fontSize: 12,
                    color: "var(--ink-muted)",
                  }}
                >
                  {Math.round(pctOfTotal)}% of total
                </div>
              </div>
            );
          })
        )}
      </div>

      </div>

      {/* Apify provider usage — tracked, never capped */}
      {hasApifyProviderFetch || apifyCents > 0 || apifyUnverifiedCents > 0 ? (
        <div className="card" style={{ marginTop: 24 }}>
          <div className="card-h">
            <h3>Apify provider usage</h3>
            <span className="tag tag-ok">not counted toward limit</span>
          </div>
          <div
            style={{ color: "var(--ink-muted)", fontSize: 13, marginBottom: 10, maxWidth: "62ch" }}
          >
            Usage fetched from Apify for the selected calendar range. Expenses from retired tokens stay included.
          </div>
          <div
            className="stack-phone"
            style={{
              display: "grid",
              gridTemplateColumns: "1fr 110px",
              gap: 16,
              alignItems: "center",
              padding: "14px 0",
            }}
          >
            <div>
              <div style={{ fontWeight: 500 }}>Fetched provider total</div>
              <div style={{ marginTop: 4, color: "var(--ink-muted)", fontSize: 12 }}>
                {formatFetchedAt(apifyProvider.fetchedAt)}
              </div>
            </div>
            <div style={{ textAlign: "right", fontFamily: "var(--mono)", fontSize: 13 }}>
              {apifyProviderAmount}
            </div>
          </div>
          {apifyUnverifiedCents > 0 ? (
            <div
              className="stack-phone"
              style={{
                display: "grid",
                gridTemplateColumns: "1fr 110px",
                gap: 16,
                alignItems: "center",
                padding: "14px 0",
                borderTop: "1px dashed var(--rule-soft)",
              }}
            >
              <div>
                <div style={{ fontWeight: 500 }}>Run charges · unverified</div>
                <div style={{ marginTop: 4, color: "var(--ink-muted)", fontSize: 12 }}>
                  Recorded charges outside the saved provider readings&apos; coverage.
                </div>
              </div>
              <div style={{ textAlign: "right", fontFamily: "var(--mono)", fontSize: 13 }}>
                {formatCents(apifyUnverifiedCents)}
              </div>
            </div>
          ) : null}
        </div>
      ) : null}

      {/* X API — flat monthly subscription, tracked apart, never capped */}
      {xapi.monthlyCostCents > 0 || xapi.postsThisMonth + xapi.repliesThisMonth > 0 ? (
        <div className="card" style={{ marginTop: 24 }}>
          <div className="card-h">
            <h3>X API · {xapi.tier} tier</h3>
            <span className="tag tag-ok">fixed subscription · not counted toward limit</span>
          </div>
          <div
            style={{ color: "var(--ink-muted)", fontSize: 13, marginBottom: 12, maxWidth: "62ch" }}
          >
            Vega&apos;s posts + replies go through the official X API, which bills a flat monthly
            tier (not per call). Shown here for visibility; it never trips a budget cap or pauses
            the agent.
          </div>
          <div style={{ display: "flex", gap: 28, flexWrap: "wrap", alignItems: "baseline" }}>
            <div>
              <span className="serif" style={{ fontSize: 26, lineHeight: 1 }}>
                {formatCents(xapi.monthlyCostCents)}
              </span>
              <span style={{ fontSize: 13, color: "var(--ink-muted)" }}> / month</span>
            </div>
            <div style={{ fontFamily: "var(--mono)", fontSize: 13, color: "var(--ink-2)" }}>
              {xapi.postsThisMonth} post{xapi.postsThisMonth === 1 ? "" : "s"} ·{" "}
              {xapi.repliesThisMonth} repl{xapi.repliesThisMonth === 1 ? "y" : "ies"}{" "}
              <span style={{ color: "var(--ink-muted)" }}>written this month</span>
            </div>
          </div>
        </div>
      ) : null}

      {/* Plan B overflow */}
      <div className="card" style={{ marginTop: 24, background: "var(--paper-2)" }}>
        <div style={{ display: "flex", gap: 16, alignItems: "center", flexWrap: "wrap" }}>
          <div className="serif" style={{ fontSize: 28, lineHeight: 1 }}>
            Plan B overflow
          </div>
          <div className="plan-b-actions" style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
            <span className="tag tag-ok">
              <span className="dot dot-ok" /> off
            </span>
            <button type="button" className="btn btn-sm" disabled>
              Configure
            </button>
          </div>
        </div>
        <div style={{ color: "var(--ink-muted)", fontSize: 13, marginTop: 6, maxWidth: "62ch" }}>
          When your BYOK subscription hits its rate limit, agents can fall back to Noelle&apos;s API
          at metered rates. Off by default. Cap and per-agent overrides available.
        </div>
      </div>
    </div>
  );
}
