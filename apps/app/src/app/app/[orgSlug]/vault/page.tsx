import { AppLink as Link } from "@/components/nav/AppLink";
import { notFound } from "next/navigation";
import { PageHeader } from "@/components/nav/PageHeader";
import { VaultFileListing, type VaultFileListingState } from "@/components/vault/VaultFileListing";
import { getOrgBySlug } from "@/lib/queries";
import { getVaultForOrg, listAnchorUsageForOrg, listVaultFilesForOrg, VaultListingError } from "@/lib/vault";
import { timeAgoShort } from "@/lib/agent-activity-copy";
import type { VaultNode } from "@/lib/vault-types";
import { buildVaultTree, vaultStats } from "@/lib/vault-tree";

interface PageProps {
  params: Promise<{ orgSlug: string }>;
  searchParams?: Promise<{ pageToken?: string | string[] }>;
}

/** First file path in a tree (depth-first), for the browser's initial selection. */
function firstFilePath(nodes: VaultNode[]): string {
  for (const n of nodes) {
    if (n.type === "file") return n.path;
    const found = firstFilePath(n.children);
    if (found) return found;
  }
  return "";
}

export default async function VaultPage({ params, searchParams }: PageProps) {
  const { orgSlug } = await params;
  const org = await getOrgBySlug(orgSlug);
  if (!org) notFound();

  const vault = await getVaultForOrg(org.id);
  const usageRows = vault ? await listAnchorUsageForOrg(org.id, 20) : [];

  const { pageToken } = await searchParams ?? {};
  let listing: VaultFileListingState = { status: "unprovisioned", source: null, files: [], partial: false, nextPageToken: null };
  if (vault) {
    try {
      if (Array.isArray(pageToken)) throw new VaultListingError("invalid_page");
      listing = await listVaultFilesForOrg(org.id, pageToken === undefined ? {} : { pageToken });
    } catch (error) {
      if (error instanceof VaultListingError && error.code === "invalid_page") listing = { status: "invalid_page" };
      else throw error;
    }
  }
  const liveFiles = "files" in listing ? listing.files : [];
  const tree = buildVaultTree(liveFiles, vault?.storage_prefix ?? "");
  const stats = vaultStats(liveFiles, vault?.storage_prefix ?? "");
  const newestListedISO = liveFiles.reduce<string | null>(
        (acc, f) => (acc === null || Date.parse(f.updatedISO) > Date.parse(acc) ? f.updatedISO : acc),
        null,
      );
  const initialPath = firstFilePath(tree);
  const ready = listing.status === "ready";

  // Missing libraries use the existing writing setup.
  if (!vault) {
    return (
      <>
        <PageHeader
          eyebrow="vault"
          title={
            <>
              No <em>vault</em> yet.
            </>
          }
          sub={
            <>
              Save your voice and audience in the writing setup to give drafts useful context.
            </>
          }
        />
        <div className="card" style={{ padding: 24 }}>
          <p style={{ marginTop: 0 }}>
            A connected voice library appears here when it is configured. You can start with the voice wizard.
          </p>
          <p style={{ marginBottom: 0 }}>
            <Link href={`/app/${orgSlug}/onboarding/vault`}>Set up your voice</Link>
          </p>
        </div>
      </>
    );
  }

  // Status comes from the configured library.
  const workspaceLabel = vault.nella_workspace_id;
  const statusLabel = vault.status;
  const statusTone =
    statusLabel === "active" ? "tag-good" : statusLabel === "provisioning" ? "tag-warn" : "tag-warn";

  const anchorUsage = usageRows.length
    ? usageRows.map((u) => ({
        draftTitle: `Draft ${u.draft_id?.slice(0, 8) ?? "(removed)"}`,
        agentSlug: u.agent_role,
        agentLabel: u.agent_role.toUpperCase(),
        whenISO: u.created_at,
        anchorPaths: u.anchor_paths,
      }))
    : [];

  return (
    <>
      <PageHeader
        eyebrow={`${workspaceLabel} workspace`}
        title={
          <>
            Inside the <em>vault</em>.
          </>
        }
        sub={
          <>
            Browse the current page of your configured vault, preview files,
            and see recent recorded anchor usage.
          </>
        }
        right={
          <span className={`tag ${statusTone}`}>
            <span
              className={`dot ${statusTone === "tag-good" ? "dot-good" : "dot-warn"}`}
            />{" "}
            {statusLabel}
          </span>
        }
      />

      {/* Metadata counts and modification time describe only this page. */}
      <div className="kpi-strip" style={{ gap: 14, marginBottom: 22 }}>
        <StatCard label="Folders on this page" value={ready ? String(stats.folders) : "—"} sub="folders represented by listed files" />
        <StatCard label="Files on this page" value={ready ? String(stats.files) : "—"} sub={listing.status === "ready" && listing.source === "local" ? "local markdown files" : "listed file metadata"} />
        <StatCard label="Newest listed file" value={newestListedISO ? timeAgoShort(newestListedISO) : "—"} sub="file modification time on this page" />
      </div>

      <VaultFileListing state={listing} tree={tree} initialSelected={initialPath} orgId={org.id} orgSlug={orgSlug}
        workspaceLabel={workspaceLabel} {...(typeof pageToken === "string" ? { pageToken } : {})} />

      {/* Recent recorded anchor usage. */}
      <section style={{ marginTop: 28 }}>
        <div
          style={{
            display: "flex",
            alignItems: "baseline",
            justifyContent: "space-between",
            marginBottom: 12,
          }}
        >
          <div>
            <div className="eyebrow">Activity</div>
            <h2
              className="serif"
              style={{
                fontSize: 24,
                lineHeight: 1.1,
                margin: "4px 0 0 0",
                fontWeight: 400,
              }}
            >
              Recent anchor usage
            </h2>
          </div>
          <span
            className="mono"
            style={{ fontSize: 11, color: "var(--ink-muted)" }}
          >
            {anchorUsage.length} drafts
          </span>
        </div>

        <div className="card" style={{ padding: 0, overflow: "hidden", ["--pad" as string]: "0px" }}>
          {anchorUsage.map((usage, idx) => (
            <div
              key={`${usage.agentSlug}-${usage.whenISO}-${idx}`}
              className="stack-phone"
              style={{
                padding: "16px 22px",
                borderTop: idx === 0 ? "none" : "1px solid var(--rule-soft)",
                display: "grid",
                gridTemplateColumns: "1fr auto",
                gap: 16,
                alignItems: "start",
              }}
            >
              <div style={{ minWidth: 0 }}>
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 10,
                    flexWrap: "wrap",
                  }}
                >
                  <span
                    className="serif"
                    style={{ fontSize: 17, lineHeight: 1.2 }}
                  >
                    {usage.draftTitle}
                  </span>
                  <span className="tag tag-acc">{usage.agentSlug}</span>
                </div>
                <div
                  className="mono"
                  style={{
