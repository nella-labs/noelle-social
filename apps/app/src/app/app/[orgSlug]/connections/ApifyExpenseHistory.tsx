import type { ApifyTokenSpend } from "@/lib/apify-spend-model";
import { formatCents } from "@/lib/utils";

function dateLabel(value: string) {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(value));
}

function tokenLabel(value: string) {
  return value.trim() || "Unknown token";
}

/** Expenses survive token retirement; each provider account contributes once. */
export function ApifyExpenseHistory({ spend }: { spend: ApifyTokenSpend[] }) {
  const accounts = new Map<string, ApifyTokenSpend>();
  for (const s of spend)
    if (s.source === "provider" && s.accountId) {
      const previous = accounts.get(s.accountId);
      if (!previous || s.active) accounts.set(s.accountId, s);
    }
  const reported = [...accounts.values()];
  const unverified = spend.filter((s) => s.source === "unverified");
  return (
    <div style={{ marginTop: 18 }}>
      <div className="eyebrow">Apify reported usage</div>
      <p style={{ fontSize: 12, color: "var(--ink-muted)" }}>
        Latest saved billing cycle per account. Retired tokens keep their expenses. Shared accounts
        count once.
      </p>
      {reported.length === 0 ? (
        <p style={{ fontSize: 12 }}>No provider balances fetched yet. Use Test to refresh.</p>
      ) : (
        <dl style={{ margin: 0, fontSize: 12 }}>
          {reported.map((s) => (
            <div
              key={s.accountId}
              style={{ padding: "8px 0", borderTop: "1px dashed var(--rule-soft)" }}
            >
              <div style={{ display: "flex", justifyContent: "space-between", gap: 12 }}>
                <dt>
                  {tokenLabel(s.label)}
                  {!s.active ? " · retired" : ""}
                </dt>
                <dd style={{ margin: 0, fontFamily: "var(--mono)" }}>{formatCents(s.cents)}</dd>
              </div>
              <div style={{ marginTop: 4, color: "var(--ink-muted)" }}>
                {dateLabel(s.cycleStartAt!)} – {dateLabel(s.cycleEndAt!)} · fetched{" "}
                {dateLabel(s.fetchedAt!)}
              </div>
            </div>
          ))}
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              paddingTop: 10,
              borderTop: "1px solid var(--rule)",
              fontWeight: 600,
            }}
          >
            <dt>Last reported total</dt>
            <dd style={{ margin: 0 }}>{formatCents(reported.reduce((a, s) => a + s.cents, 0))}</dd>
          </div>
        </dl>
      )}
      {unverified.length > 0 ? (
        <div style={{ marginTop: 18 }}>
          <div className="eyebrow">Run charges · unverified</div>
          <p style={{ fontSize: 12, color: "var(--ink-muted)" }}>
            Recorded charges outside the saved provider readings&apos; coverage. Kept separate
            from Apify&apos;s reported total.
          </p>
          <dl style={{ margin: 0, fontSize: 12 }}>
            {unverified.map((s, i) => (
              <div
                key={`${s.credentialId}-${i}`}
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  gap: 12,
                  padding: "6px 0",
                }}
              >
                <dt>
                  {tokenLabel(s.label)}
                  {!s.active ? " · retired" : ""}
                </dt>
                <dd style={{ margin: 0 }}>{formatCents(s.cents)}</dd>
              </div>
            ))}
          </dl>
        </div>
      ) : null}
    </div>
  );
}
