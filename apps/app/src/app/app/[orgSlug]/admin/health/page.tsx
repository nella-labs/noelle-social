import { AdminGate } from "@/components/admin/AdminGate";
import { AdminPageHeader } from "@/components/admin/AdminPageHeader";
import { AdminSection } from "@/components/admin/AdminSection";
import { AdminTabs } from "@/components/admin/AdminTabs";
import { Kpi } from "@/components/admin/Kpi";
import { KumaLiveStatus } from "@/components/admin/KumaLiveStatus";
import { fetchKumaHealthSummary } from "@/components/admin/KumaHealthOverview";
import { checkAdmin } from "@/lib/admin-gate";
import { getKumaConfig } from "@/lib/kuma";

interface PageProps {
  params: Promise<{ orgSlug: string }>;
}

export default async function AdminHealthPage({ params }: PageProps) {
  const { orgSlug } = await params;
  const { isAdmin } = await checkAdmin();
  if (!isAdmin) {
    return (
      <>
        <AdminPageHeader
          eyebrow="Operations · Health"
          title={<>Health.</>}
          sub="Service status."
        />
        <AdminGate />
      </>
    );
  }

  const kuma = await fetchKumaHealthSummary();
  const cfg = getKumaConfig();
  const okN = kuma?.ok ?? 0;
  const warnN = kuma?.warn ?? 0;
  const downN = kuma?.down ?? 0;
  const totalN = kuma?.total ?? 0;
  const healthPct = totalN > 0 ? (okN / totalN) * 100 : null;
  const reachable = kuma?.reachable === true;

  return (
    <>
      <AdminPageHeader
        eyebrow="Operations · Health"
        title={
          <>
            <em>Health.</em>
          </>
        }
        sub="Live from status.trynoelle.com (Uptime Kuma). Heartbeats and uptime roll-ups refresh every 30s."
      />

      <AdminTabs active="health" orgSlug={orgSlug} />

      <div className="grid-4" style={{ marginBottom: 24 }}>
        <Kpi
          label="System health"
          value={healthPct == null ? "—" : `${healthPct.toFixed(2)}%`}
          sub={reachable ? "rolling 24h · live" : "kuma unreachable"}
          tone={!reachable ? "warn" : warnN > 0 || downN > 0 ? "warn" : "ok"}
        />
        <Kpi label="Healthy" value={okN} tone="ok" />
        <Kpi label="Warning" value={warnN} tone={warnN > 0 ? "warn" : "muted"} />
        <Kpi label="Down" value={downN} tone={downN > 0 ? "warn" : "muted"} />
      </div>

      <AdminSection
        title="Monitors"
        sub="Pulled from status.trynoelle.com. Add or edit in the Kuma admin."
        right={
          <a
            href={`${cfg.baseUrl}/status/${cfg.slug}`}
            target="_blank"
            rel="noreferrer"
            className="mono"
            style={{ fontSize: 11, letterSpacing: "0.08em", textTransform: "uppercase" }}
          >
            public page ↗
          </a>
        }
      >
        <KumaLiveStatus />
      </AdminSection>
    </>
  );
}
