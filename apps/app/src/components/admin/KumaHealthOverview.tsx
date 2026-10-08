import { AppLink as Link } from "@/components/nav/AppLink";
import { fetchKumaStatus, getKumaConfig, type KumaHeartbeat, type KumaMonitor } from "@/lib/kuma";

const PULSE_TICKS = 24;

function deriveTier(m: KumaMonitor): string {
  if (m.type === "http" || m.type === "keyword") return "HTTP · external";
  if (m.type === "port") return "TCP · local";
  if (m.type === "ping") return "ICMP";
  if (m.type === "push") return "PUSH · agent";
  return m.type.toUpperCase();
}

function formatPing(ms: number | null): string {
  if (ms == null || ms <= 0) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function PulseBars({ beats }: { beats: KumaHeartbeat[] }) {
  const trimmed = beats.slice(-PULSE_TICKS);
  const padded: (KumaHeartbeat | null)[] = [
    ...Array<KumaHeartbeat | null>(Math.max(0, PULSE_TICKS - trimmed.length)).fill(null),
    ...trimmed,
  ];
  return (
    <div style={{ display: "flex", gap: 1.5, alignItems: "flex-end", height: 22 }}>
      {padded.map((b, i) => {
        let bg = "var(--rule)";
        let height = 8;
        if (b) {
          if (b.status === "up") {
            bg = "var(--ok)";
            height = 18;
          } else if (b.status === "down") {
            bg = "var(--danger)";
            height = 6;
          } else if (b.status === "maintenance") {
            bg = "var(--ink-muted)";
            height = 12;
          } else {
            bg = "var(--warn)";
            height = 14;
          }
        }
        return (
          <span
            key={i}
            style={{ width: 8, height, background: bg, borderRadius: 1, opacity: 0.92 }}
          />
        );
      })}
    </div>
  );
}

interface KumaHealthOverviewProps {
  orgSlug: string;
  limit?: number;
}

export async function KumaHealthOverview({ orgSlug, limit = 6 }: KumaHealthOverviewProps) {
  const { baseUrl, slug } = getKumaConfig();
  const snapshot = await fetchKumaStatus(slug, { baseUrl });

  if (!snapshot) {
    return (
      <div
        className="card"
        style={{
          padding: 22,
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 16,
        }}
      >
        <div>
          <div style={{ fontWeight: 500, fontSize: 13 }}>Uptime Kuma unreachable</div>
          <div style={{ marginTop: 4, color: "var(--ink-muted)", fontSize: 12 }}>
            Couldn&apos;t fetch <span className="mono">{baseUrl}</span>. The card stays empty until
            cloudflared on noelle-vm-0 responds again.
          </div>
        </div>
        <a
          href={`${baseUrl}/status/${slug}`}
          target="_blank"
          rel="noreferrer"
          className="mono"
          style={{ fontSize: 11, letterSpacing: "0.08em", textTransform: "uppercase" }}
        >
          open status ↗
        </a>
      </div>
    );
  }

  const monitors = snapshot.monitors.slice(0, limit);

  return (
    <div className="card" style={{ padding: 0, overflow: "hidden" }}>
      {monitors.length === 0 ? (
        <div style={{ padding: "20px 18px", color: "var(--ink-muted)", fontSize: 12 }}>
          No monitors on the <span className="mono">{slug}</span> status page yet.
        </div>
      ) : (
        monitors.map((m, i) => {
          const dotTone =
            m.status === "up"
              ? "ok"
              : m.status === "down"
                ? "danger"
                : m.status === "maintenance"
                  ? "muted"
                  : "warn";
          const uptime = m.uptime24h != null ? m.uptime24h * 100 : null;
          return (
            <div
              key={m.id}
              className="stack-phone"
              style={{
                display: "grid",
                gridTemplateColumns: "1fr 120px 280px 80px 70px 90px",
                gap: 14,
                alignItems: "center",
                padding: "14px 18px",
                borderTop: i === 0 ? 0 : "1px solid var(--rule-soft)",
              }}
            >
              <div style={{ minWidth: 0 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span className={`dot dot-${dotTone}`} />
                  <span style={{ fontWeight: 500, fontSize: 13 }}>{m.name}</span>
                </div>
                {m.status === "down" ? (
                  <div style={{ marginTop: 4, fontSize: 11.5, color: "var(--danger)" }}>
                    ⚠ failing — last check {m.lastCheckAt ?? "—"}
                  </div>
                ) : null}
              </div>
              <div
                className="mono"
                style={{
                  fontSize: 10.5,
                  color: "var(--ink-muted)",
                  textTransform: "uppercase",
                  letterSpacing: "0.06em",
                }}
              >
                {deriveTier(m)}
              </div>
              <PulseBars beats={m.beats} />
              <div
                className="mono"
                style={{ fontSize: 12, color: "var(--ink-2)", textAlign: "right" }}
              >
                {formatPing(m.p95Ms ?? m.lastPingMs)}
              </div>
              <div
                className="mono"
                style={{
                  fontSize: 11,
                  color: uptime == null ? "var(--ink-muted)" : uptime < 99 ? "var(--warn)" : "var(--ok)",
                  textAlign: "right",
                }}
              >
                {uptime == null ? "—" : `${uptime.toFixed(2)}%`}
              </div>
              <Link
                href={`/app/${orgSlug}/admin/health`}
                className="btn btn-sm btn-ghost"
                style={{ justifySelf: "end" }}
              >
                logs →
              </Link>
            </div>
          );
        })
      )}
    </div>
  );
}

export async function fetchKumaHealthSummary(): Promise<{
  ok: number;
  warn: number;
  down: number;
  total: number;
  reachable: boolean;
} | null> {
  const { baseUrl, slug } = getKumaConfig();
  const snapshot = await fetchKumaStatus(slug, { baseUrl });
  if (!snapshot) return { ok: 0, warn: 0, down: 0, total: 0, reachable: false };
  let ok = 0;
  let warn = 0;
  let down = 0;
  for (const m of snapshot.monitors) {
    if (m.status === "up") ok += 1;
    else if (m.status === "down") down += 1;
    else warn += 1;
