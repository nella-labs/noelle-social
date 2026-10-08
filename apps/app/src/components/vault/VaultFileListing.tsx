import { AppLink as Link } from "@/components/nav/AppLink";
import { VaultBrowser } from "@/components/vault/VaultBrowser";
import type { VaultNode } from "@/lib/vault-types";
import type { VaultListingPage } from "@/lib/vault";

export type VaultFileListingState = VaultListingPage | { status: "invalid_page" };

/** Current vault metadata, its read state and bounded continuation controls. */
export function VaultFileListing({ state, tree, initialSelected, orgSlug, orgId, workspaceLabel, pageToken }: {
  state: VaultFileListingState;
  tree: VaultNode[];
  initialSelected: string;
  orgSlug: string;
  orgId: string;
  workspaceLabel: string;
  pageToken?: string;
}) {
  const firstPageHref = `/app/${orgSlug}/vault`;
  const nextPageHref = state.status === "ready" && state.nextPageToken
    ? `${firstPageHref}?${new URLSearchParams({ pageToken: state.nextPageToken })}` : null;
  const partial = "partial" in state && state.partial;
  const hasFiles = state.status === "ready" && state.files.length > 0;
  const unavailable = state.status === "invalid_page" || state.status === "unavailable";
  const notice = unavailable ? (
    <>
      <p style={{ marginTop: 0 }}>{state.status === "invalid_page" ? "This listing page is no longer available. Start from the first page." : state.message}</p>
      <Link className="btn btn-sm btn-ghost" href={firstPageHref}>First page</Link>
    </>
  ) : state.status === "unprovisioned" ? (
    <>This vault is no longer provisioned. <Link href={`/app/${orgSlug}/settings`}>Open settings</Link> to check its configuration.</>
  ) : (
    <p style={{ margin: 0 }}>{partial ? "The partial scan found no files to display. This does not establish that the vault is empty."
      : pageToken !== undefined || nextPageHref ? "No files on this page."
      : state.status === "ready" && state.source === "local" ? "No markdown files found in the local vault."
      : "No files found in the cloud vault."}</p>
  );

  return (
    <>
      {partial && (
        <div className="card" role="status" style={{ padding: 16, marginBottom: 16 }}>
          <strong>Partial local scan</strong>
          <p style={{ marginBottom: 0 }}>Some files or folders could not be listed, or the scan reached its limit. These pages show only the files it found.</p>
        </div>
      )}
      {hasFiles ? (
        <VaultBrowser key={pageToken ?? "first"} tree={tree} initialSelected={initialSelected} orgId={orgId} workspaceLabel={workspaceLabel} />
      ) : (
        <div className="card" role={unavailable ? "alert" : undefined} style={{ padding: 24 }}>{notice}</div>
      )}
      {state.status === "ready" && (pageToken !== undefined || nextPageHref) && (
        <nav aria-label="Vault file pages" style={{ display: "flex", gap: 12, marginTop: 16 }}>
          {pageToken !== undefined && <Link className="btn btn-sm btn-ghost" href={firstPageHref}>First page</Link>}
          {nextPageHref && <Link className="btn btn-sm btn-ghost" href={nextPageHref}>Next page</Link>}
        </nav>
      )}
    </>
  );
}
