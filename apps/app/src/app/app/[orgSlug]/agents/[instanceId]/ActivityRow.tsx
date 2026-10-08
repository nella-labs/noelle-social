/**
 * One row in an agent's activity feed. Shared between the agent detail page
 * (which shows the latest few) and the full activity page (which shows all).
 */
export function ActivityRow({
  when,
  verb,
  what,
  cost,
  model,
  url,
  first,
}: {
  when: string;
  verb: string;
  what: string;
  cost?: string;
  model?: string;
  /** Live X permalink (sent replies) — rendered as a "view reply ↗" link. */
  url?: string | null;
  first?: boolean;
}) {
  return (
    <div
      className="activity-row"
      style={{
        display: "grid",
        gridTemplateColumns: "56px 96px 1fr 80px 60px",
        gap: 14,
        alignItems: "baseline",
        padding: "12px 0",
        borderTop: first ? 0 : "1px dashed var(--rule-soft)",
      }}
    >
      <span style={{ fontFamily: "var(--mono)", fontSize: 11.5, color: "var(--ink-soft)" }}>
        {when}
      </span>
      <span
        style={{
          fontFamily: "var(--mono)",
          fontSize: 10.5,
          letterSpacing: "0.08em",
          textTransform: "uppercase",
          color: "var(--ink-muted)",
        }}
      >
        {verb}
      </span>
      <span style={{ fontSize: 13, color: "var(--ink-2)", minWidth: 0 }}>
        {what}
        {url ? (
          <a
            href={url}
            target="_blank"
            rel="noreferrer"
            style={{
              marginLeft: 8,
              color: "var(--accent)",
              whiteSpace: "nowrap",
              fontFamily: "var(--mono)",
              fontSize: 11.5,
            }}
          >
            view reply ↗
          </a>
        ) : null}
      </span>
      <span
        style={{
          fontFamily: "var(--mono)",
          fontSize: 11,
          color: "var(--ink-muted)",
          textAlign: "right",
        }}
      >
        {model ?? ""}
      </span>
      <span
        style={{
          fontFamily: "var(--mono)",
          fontSize: 11.5,
          color: "var(--ink-2)",
          textAlign: "right",
        }}
      >
        {cost ?? ""}
      </span>
    </div>
  );
}

/** Relative time label: HH:MM today, "Nd ago" beyond 24h. */
export function formatWhen(iso: string): string {
  const d = new Date(iso);
  const now = Date.now();
  const diffMs = now - d.getTime();
  if (diffMs < 24 * 60 * 60 * 1000) {
    return d.toLocaleTimeString("en-US", {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
  }
  const days = Math.floor(diffMs / (24 * 60 * 60 * 1000));
  return `${days}d ago`;
}
