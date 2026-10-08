import { notFound } from "next/navigation";
import type { SystemStatus, ServiceState } from "@noelle/contracts";
import { PageHeader } from "@/components/nav/PageHeader";
import { getOrgBySlug } from "@/lib/queries";
import { noelleFetch } from "@/lib/api";

export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ orgSlug: string }>;
}

const STATE_TONE: Record<ServiceState, { dot: string; label: string }> = {
  ok: { dot: "var(--ok)", label: "ok" },
  degraded: { dot: "var(--warn)", label: "degraded" },
  down: { dot: "var(--danger)", label: "down" },
  disabled: { dot: "var(--ink-muted)", label: "off" },
};

function StatusDot({ state }: { state: ServiceState }) {
  return (
    <span
      style={{
        display: "inline-block",
        width: 8,
        height: 8,
        borderRadius: 999,
        background: STATE_TONE[state].dot,
      }}
    />
  );
}

function fmtUptime(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const m = Math.floor(seconds / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  const d = Math.floor(h / 24);
  return `${d}d ${h % 24}h`;
}

function fmtAgo(iso: string | null): string {
  if (!iso) return "never";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "—";
  const secs = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (secs < 60) return `${secs}s ago`;
  const m = Math.floor(secs / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export default async function SystemPage({ params }: PageProps) {
  const { orgSlug } = await params;
  const org = await getOrgBySlug(orgSlug);
  if (!org) notFound();

  let status: SystemStatus | null = null;
  let fetchError: string | null = null;
  try {
    status = await noelleFetch<SystemStatus>("/api/system/status");
  } catch (err) {
    fetchError = err instanceof Error ? err.message : String(err);
  }

  return (
    <>
      <PageHeader
        eyebrow="System"
        title={
          <>
            What&apos;s running on <em>this box</em>.
          </>
        }
        sub="Live status for your self-hosted Noelle: services, agent workers, configured model providers, and the applied database schema."
      />

      {fetchError ? (
        <div className="card" style={{ borderColor: "var(--danger)" }}>
          <div className="card-h">
            <h3>Backend unreachable</h3>
            <span className="tag">
              <StatusDot state="down" /> api-vm
            </span>
          </div>
          <div style={{ color: "var(--ink-muted)", fontSize: 13, marginTop: 6 }}>
            Couldn&apos;t reach the API service to read system status:{" "}
            <code style={{ fontFamily: "var(--mono)" }}>{fetchError}</code>
            <br />
            Check that api-vm is up (<code style={{ fontFamily: "var(--mono)" }}>
              noelle status
            </code>
            ) and that <code style={{ fontFamily: "var(--mono)" }}>NOELLE_API_BASE_URL</code> points
            at it.
          </div>
        </div>
      ) : status ? (
        <>
          {/* Host summary */}
          <div className="card" style={{ marginBottom: 24 }}>
            <div className="card-h">
              <h3>Host</h3>
              <span className={`tag ${status.ok ? "tag-ok" : ""}`}>
                <StatusDot state={status.ok ? "ok" : "down"} />{" "}
                {status.ok ? "healthy" : "degraded"}
              </span>
            </div>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))",
                gap: 16,
                fontSize: 13,
              }}
            >
              <Stat label="Platform" value={status.host.platform} />
              <Stat label="Uptime" value={fmtUptime(status.host.uptimeSeconds)} />
              <Stat label="Version" value={status.host.version} />
              <Stat
                label="Tunnel"
                value={status.host.tunnel ?? "localhost only"}
              />
            </div>
          </div>

          <div
            className="grid-2"
            style={{
              gap: 24,
              marginBottom: 24,
            }}
          >
            {/* Services */}
            <div className="card">
              <div className="card-h">
                <h3>Services</h3>
                <span className="tag">{status.services.length}</span>
              </div>
              {status.services.map((s, i) => (
                <div
                  key={s.name}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 10,
                    padding: "12px 0",
                    borderTop: i === 0 ? 0 : "1px dashed var(--rule-soft)",
                    flexWrap: "wrap",
                  }}
                >
                  <StatusDot state={s.state} />
                  <span style={{ fontWeight: 500, minWidth: 0 }}>{s.name}</span>
                  <span
                    style={{
                      marginLeft: "auto",
                      fontFamily: "var(--mono)",
                      fontSize: 12,
                      color: "var(--ink-muted)",
                    }}
                  >
                    {s.detail ?? STATE_TONE[s.state].label}
                    {typeof s.latencyMs === "number" ? ` · ${s.latencyMs}ms` : ""}
                  </span>
                </div>
              ))}
            </div>

            {/* Model providers */}
            <div className="card">
              <div className="card-h">
                <h3>Model providers</h3>
                <span className="tag">
                  {Object.values(status.providers).filter(Boolean).length} configured
                </span>
              </div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 4 }}>
                {(
                  Object.entries(status.providers) as Array<[string, boolean]>
                ).map(([name, on]) => (
                  <span
                    key={name}
                    className={`tag ${on ? "tag-ok" : ""}`}
                    style={!on ? { opacity: 0.5 } : undefined}
                  >
                    <StatusDot state={on ? "ok" : "disabled"} /> {name}
                  </span>
                ))}
              </div>
              <div
                style={{
                  color: "var(--ink-muted)",
                  fontSize: 12,
                  marginTop: 12,
                }}
              >
                AI runs on your own provider keys — nothing is self-hosted here.
              </div>
            </div>
          </div>

          {/* Agent workers */}
          <div className="card" style={{ marginBottom: 24 }}>
            <div className="card-h">
              <h3>Agent workers</h3>
              <span className="tag">
                {status.workerRuns.some((w) => w.enabled) ? "enabled" : "off (v1)"}
              </span>
            </div>
            {status.workerRuns.map((w, i) => {
              const state: ServiceState = !w.enabled
                ? "disabled"
                : w.stale
                  ? "degraded"
                  : "ok";
              return (
                <div
                  key={w.kind}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 10,
                    padding: "12px 0",
                    borderTop: i === 0 ? 0 : "1px dashed var(--rule-soft)",
                    flexWrap: "wrap",
                  }}
                >
                  <StatusDot state={state} />
                  <span style={{ fontWeight: 500, minWidth: 0 }}>{w.kind}</span>
                  <span
                    style={{
                      marginLeft: "auto",
                      fontFamily: "var(--mono)",
                      fontSize: 12,
                      color: "var(--ink-muted)",
                    }}
                  >
                    {!w.enabled
                      ? "disabled"
                      : `last ok ${fmtAgo(w.lastSuccessAt)}${w.stale ? " · stale" : ""}`}
                  </span>
                </div>
              );
            })}
          </div>

          {/* Schema */}
          <div className="card">
            <div className="card-h">
              <h3>Database schema</h3>
              <span className="tag">{status.schema.applied.length} applied</span>
            </div>
            {status.schema.applied.length === 0 ? (
              <div style={{ color: "var(--ink-muted)", fontSize: 13 }}>
                No migration ledger found. (On a managed deployment this is
                expected; on self-host run <code style={{ fontFamily: "var(--mono)" }}>noelle
                migrate</code>.)
              </div>
            ) : (
              <div
                className="schema-cols"
                style={{
                  fontFamily: "var(--mono)",
                  fontSize: 12,
                  color: "var(--ink-muted)",
                  columns: 2,
                }}
              >
                {status.schema.applied.map((f) => (
                  <div key={f}>{f}</div>
                ))}
              </div>
            )}
            {status.schema.pending.length > 0 ? (
              <div style={{ marginTop: 10, color: "var(--warn)", fontSize: 12 }}>
                {status.schema.pending.length} pending: run{" "}
                <code style={{ fontFamily: "var(--mono)" }}>noelle migrate</code>.
              </div>
            ) : null}
          </div>
        </>
      ) : null}
    </>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div
        style={{
          fontFamily: "var(--mono)",
          fontSize: 11,
          textTransform: "uppercase",
          letterSpacing: "0.04em",
          color: "var(--ink-muted)",
        }}
      >
        {label}
      </div>
      <div style={{ marginTop: 2, fontWeight: 500 }}>{value}</div>
    </div>
  );
}
