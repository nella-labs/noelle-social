import { AdminGate } from "@/components/admin/AdminGate";
import { AdminPageHeader } from "@/components/admin/AdminPageHeader";
import { AdminSection } from "@/components/admin/AdminSection";
import { AdminTabs } from "@/components/admin/AdminTabs";
import { LlmBackendToggle } from "@/components/admin/LlmBackendToggle";
import { checkAdmin } from "@/lib/admin-gate";
import { getOrgBySlug } from "@/lib/queries";

type Backend = "aws" | "claude";

// `NoelleOrganization` is a generated Supabase type that predates the
// llm_backend column (the column lives in Cloud SQL, added by the schema task).
// getOrgBySlug does `select *`, so the value is present at runtime — narrow it
// here without touching the generated type.
function readBackend(org: unknown): Backend {
  const v = (org as { llm_backend?: unknown } | null)?.llm_backend;
  return v === "aws" ? "aws" : "claude"; // default 'claude'
}

interface PageProps {
  params: Promise<{ orgSlug: string }>;
}

export default async function AdminInfrastructurePage({ params }: PageProps) {
  const { orgSlug } = await params;
  const { isAdmin } = await checkAdmin();
  if (!isAdmin) {
    return (
      <>
        <AdminPageHeader
          eyebrow="Operations · Infrastructure"
          title={<>Infrastructure.</>}
          sub="Agent backend + runtime controls."
        />
        <AdminGate />
      </>
    );
  }

  const org = await getOrgBySlug(orgSlug);
  const backend = readBackend(org);

  return (
    <>
      <AdminPageHeader
        eyebrow="Operations · Infrastructure"
        title={
          <>
            <em>Infrastructure.</em>
          </>
        }
        sub="Global controls for how the agents run."
      />

      <AdminTabs active="infrastructure" orgSlug={orgSlug} />

      <AdminSection
        title="Agent model backend"
        sub="Where every agent LLM call is routed. Applies org-wide; workers pick it up within ~30s (no restart)."
      >
        <div className="card" style={{ padding: 20 }}>
          <LlmBackendToggle orgSlug={orgSlug} initial={backend} />

          <div
            style={{
              marginTop: 18,
              paddingTop: 18,
              borderTop: "1px solid var(--rule-soft)",
              display: "grid",
              gap: 14,
              maxWidth: 680,
            }}
          >
            <div style={{ display: "flex", gap: 12, alignItems: "flex-start" }}>
              <span className="tag tag-ok" style={{ marginTop: 1 }}>
                Claude
              </span>
              <p style={{ margin: 0, fontSize: 13, lineHeight: 1.55, color: "var(--ink-muted)" }}>
                Routes agent LLM calls through the local{" "}
                <code className="mono" style={{ fontSize: 11.5 }}>claude -p</code> Max
                subscription — <strong style={{ color: "var(--ink-2)" }}>$0 per call, budget-exempt</strong>
                . Only takes effect on a VM where the Claude CLI is installed and
                logged in (the self-host VM). On hosted prod the CLI isn't present, so
                the workers fall back to AWS Bedrock automatically.
              </p>
            </div>

            <div style={{ display: "flex", gap: 12, alignItems: "flex-start" }}>
              <span className="tag tag-warn" style={{ marginTop: 1 }}>
                AWS Bedrock
              </span>
              <p style={{ margin: 0, fontSize: 13, lineHeight: 1.55, color: "var(--ink-muted)" }}>
                Routes agent LLM calls through per-token AWS Bedrock. Always available
                everywhere; you pay per token.
              </p>
            </div>
          </div>
        </div>
      </AdminSection>
    </>
  );
}
