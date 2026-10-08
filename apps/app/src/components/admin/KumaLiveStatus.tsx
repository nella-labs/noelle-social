import { fetchKumaStatus, formatRelative, getKumaConfig, type KumaMonitorStatus } from "@/lib/kuma";

function statusTone(s: KumaMonitorStatus): "ok" | "warn" | "danger" | "muted" {
  if (s === "up") return "ok";
  if (s === "down") return "danger";
  if (s === "pending") return "warn";
  if (s === "maintenance") return "muted";
  return "muted";
}

function StatusDot({ s }: { s: KumaMonitorStatus }) {
  const tone = statusTone(s);
  const cls = tone === "ok" ? "dot-ok" : tone === "danger" ? "dot-danger" : tone === "warn" ? "dot-warn" : "dot";
  return <span className={`dot ${cls}`} />;
}

function fmtUptime(v: number | null): string {
  if (v == null) return "—";
  return `${(v * 100).toFixed(2)}%`;
}

function fmtPing(v: number | null): string {
  if (v == null) return "—";
  return `${Math.round(v)}ms`;
}

export async function KumaLiveStatus() {
  const { baseUrl, slug } = getKumaConfig();
  const snapshot = await fetchKumaStatus(slug, { baseUrl });

  const publicHref = `${baseUrl}/status/${slug}`;
  const adminHref = baseUrl;

  if (!snapshot) {
    return (
      <div
        className="card"
        style={{ padding: 20, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16 }}
      >
        <div>
          <div style={{ fontSize: 13, fontWeight: 500 }}>Uptime Kuma · live</div>
          <div style={{ marginTop: 4, color: "var(--ink-muted)", fontSize: 12 }}>
            Couldn&apos;t reach <span className="mono">{baseUrl}</span>. Cloudflared on noelle-vm-0 may be down.
          </div>
        </div>
        <a
          href={publicHref}
          target="_blank"
          rel="noreferrer"
          className="mono"
          style={{ fontSize: 11, letterSpacing: "0.08em", textTransform: "uppercase" }}
        >
          open status page ↗
        </a>
      </div>
    );
  }

  const down = snapshot.monitors.filter((m) => m.status === "down").length;
  const pending = snapshot.monitors.filter((m) => m.status === "pending").length;
  const headerTone: "ok" | "warn" | "danger" = down > 0 ? "danger" : pending > 0 ? "warn" : "ok";

  return (
    <div className="card" style={{ padding: 0, overflow: "hidden" }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 16,
          flexWrap: "wrap",
          padding: "14px 18px",
          background: "var(--paper-2)",
          borderBottom: "1px solid var(--rule)",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span
            className={`dot ${headerTone === "ok" ? "dot-ok" : headerTone === "warn" ? "dot-warn" : "dot-danger"}`}
          />
          <span style={{ fontSize: 13, fontWeight: 500 }}>Uptime Kuma · {snapshot.title}</span>
          <span
            className="mono"
            style={{ fontSize: 10.5, color: "var(--ink-muted)", letterSpacing: "0.08em", textTransform: "uppercase" }}
          >
            live · revalidates 30s
          </span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap" }}>
          <a
            href={publicHref}
            target="_blank"
            rel="noreferrer"
            className="mono"
            style={{ fontSize: 11, letterSpacing: "0.08em", textTransform: "uppercase" }}
          >
            public page ↗
          </a>
          <a
            href={adminHref}
            target="_blank"
            rel="noreferrer"
            className="mono"
            style={{ fontSize: 11, color: "var(--ink-muted)", letterSpacing: "0.08em", textTransform: "uppercase" }}
          >
            kuma admin ↗
          </a>
        </div>
      </div>

      <div
        className="hide-phone"
        style={{
          display: "grid",
          gridTemplateColumns: "1.6fr 110px 100px 100px 110px",
          gap: 14,
          padding: "10px 18px",
          background: "var(--paper)",
          fontFamily: "var(--mono)",
          fontSize: 10.5,
          letterSpacing: "0.1em",
          textTransform: "uppercase",
          color: "var(--ink-muted)",
          borderBottom: "1px solid var(--rule-soft)",
        }}
      >
        <span>Monitor</span>
        <span style={{ textAlign: "right" }}>Ping</span>
        <span style={{ textAlign: "right" }}>24h</span>
        <span style={{ textAlign: "right" }}>30d</span>
        <span style={{ textAlign: "right" }}>Last check</span>
      </div>

      {snapshot.monitors.length === 0 ? (
        <div style={{ padding: "16px 18px", color: "var(--ink-muted)", fontSize: 12 }}>
          No monitors on the <span className="mono">{snapshot.slug}</span> status page yet. Add some in the Kuma UI.
        </div>
      ) : (
        snapshot.monitors.map((m, i) => (
          <div
            key={m.id}
            className="stack-phone"
            style={{
              display: "grid",
              gridTemplateColumns: "1.6fr 110px 100px 100px 110px",
              gap: 14,
              alignItems: "center",
              padding: "12px 18px",
              borderTop: i === 0 ? 0 : "1px solid var(--rule-soft)",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
              <StatusDot s={m.status} />
              <span style={{ fontSize: 13, fontWeight: 500, overflow: "hidden", textOverflow: "ellipsis" }}>
                {m.name}
              </span>
              <span
                className="mono"
                style={{
                  fontSize: 10,
                  color: "var(--ink-muted)",
                  letterSpacing: "0.06em",
                  textTransform: "uppercase",
                }}
              >
                · {m.type}
              </span>
            </div>
            <span className="mono" style={{ fontSize: 12, textAlign: "right", color: "var(--ink-2)" }}>
              {fmtPing(m.lastPingMs)}
            </span>
            <span className="mono" style={{ fontSize: 12, textAlign: "right", color: "var(--ink-2)" }}>
              {fmtUptime(m.uptime24h)}
            </span>
            <span className="mono" style={{ fontSize: 12, textAlign: "right", color: "var(--ink-2)" }}>
              {fmtUptime(m.uptime30d)}
            </span>
            <span className="mono" style={{ fontSize: 11, textAlign: "right", color: "var(--ink-muted)" }}>
              {formatRelative(m.lastCheckAt)}
            </span>
          </div>
        ))
      )}
    </div>
  );
}
