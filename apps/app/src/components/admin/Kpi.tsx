/**
 * KPI tile — used in the admin headline rows. Mirrors the `Kpi` from the
 * design dump: small mono label, large serif value, optional sub. `accent`
 * inverts to ink-background for the hero metric. `tone` colors the sub
 * (ok/warn/muted).
 */
interface KpiProps {
  label: string;
  value: React.ReactNode;
  sub?: React.ReactNode;
  accent?: boolean;
  tone?: "ok" | "warn" | "muted";
}

export function Kpi({ label, value, sub, accent, tone }: KpiProps) {
  const toneColor =
    tone === "warn" ? "var(--warn)" : tone === "ok" ? "var(--ok)" : "var(--ink-muted)";
  return (
    <div
      className="card"
      style={{
        padding: 18,
        background: accent ? "var(--ink)" : "var(--paper)",
        color: accent ? "var(--paper)" : "var(--ink)",
        boxShadow: accent ? "0 0 0 0.5px var(--ink)" : "0 0 0 0.5px var(--rule)",
      }}
    >
      <div
        style={{
          fontFamily: "var(--mono)",
          fontSize: 9.5,
          letterSpacing: "0.14em",
          textTransform: "uppercase",
          color: accent ? "color-mix(in oklch, var(--paper) 60%, var(--ink))" : "var(--ink-muted)",
        }}
      >
        {label}
      </div>
      <div
        className="serif"
        style={{ fontSize: 34, lineHeight: 1.05, marginTop: 6, letterSpacing: "-0.01em" }}
      >
        {value}
      </div>
      {sub ? (
        <div
          style={{
            marginTop: 8,
            fontSize: 11.5,
            color: accent ? "color-mix(in oklch, var(--paper) 70%, var(--ink))" : toneColor,
          }}
        >
          {sub}
        </div>
      ) : null}
    </div>
  );
}
