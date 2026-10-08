import { AppLink as Link } from "@/components/nav/AppLink";
import type { FeederSourceRow } from "@/lib/feeder-queries";
import {
  WatchlistPeoplePanel,
  type WatchlistPersonView,
} from "@/components/watchlist/WatchlistPeoplePanel";
import { FeederSourceToggle } from "./FeederSourceToggle";
import {
  addFeederSource,
  removeFeederSource,
  setFeederSourceNote,
} from "./actions";

/**
 * Source-list card for the Account Feeder (Lyra's "style sources"). A thin
 * wrapper that reuses the shared WatchlistPeoplePanel: rows are source accounts
 * keyed by handle, titled by display_name (or the handle), linked out to the
 * LinkedIn profile, with the panel's free-text slot repurposed as the operator
 * NOTE ("why we admire this account") and a per-row enable/disable toggle via
 * the panel's renderRowActions slot. Add accepts a handle, a /in/<slug> path, or
 * a full profile URL (normalised server-side).
 */
export function FeederSourcesCard({
  orgSlug,
  instanceId,
  sources,
}: {
  orgSlug: string;
  /** Real instance UUID — used by the add/remove/toggle server actions. */
  instanceId: string;
  sources: FeederSourceRow[];
}) {
  const view: WatchlistPersonView[] = sources.map((s) => ({
    id: s.id,
    title: s.display_name?.trim() || s.handle,
    subtitle: s.display_name?.trim() ? s.handle : null,
    href:
      s.platform === "linkedin"
        ? `https://www.linkedin.com/in/${s.handle}`
        : `https://x.com/${s.handle}`,
    external: true,
    objective: s.note,
    dimmed: !s.enabled,
  }));

  return (
    <WatchlistPeoplePanel
      people={view}
      title="Style sources"
      helper="Accounts whose writing the feeder learns from. On a run it pulls each one's recent posts + authored comments, ranks them by engagement, and distils a style profile the drafter samples per lead. Paste a LinkedIn profile URL or handle. Add an optional note for context; toggle a source off to skip it on the next run without losing its corpus."
      objective={{ mode: "freetext", placeholder: "optional — why this account (e.g. great hooks)" }}
      add={{ field: "handle", label: "LinkedIn URL or handle", placeholder: "linkedin.com/in/patio11" }}
      addAction={async (fd: FormData) => {
        "use server";
        const handle = String(fd.get("handle") ?? "");
        if (!handle) return;
        await addFeederSource({
          orgSlug,
          instanceId,
          handle,
          note: String(fd.get("objective") ?? ""),
        });
      }}
      removeAction={async (fd: FormData) => {
        "use server";
        await removeFeederSource({ orgSlug, instanceId, rowId: String(fd.get("rowId") ?? "") });
      }}
      setObjectiveAction={async (fd: FormData) => {
        "use server";
        await setFeederSourceNote({
          orgSlug,
          instanceId,
          rowId: String(fd.get("rowId") ?? ""),
          note: String(fd.get("objective") ?? ""),
        });
      }}
      renderRowActions={(p) => {
        const source = sources.find((s) => s.id === p.id);
        return (
          <span style={{ display: "inline-flex", alignItems: "center", gap: 10 }}>
            {source?.contact_person_id ? (
              <Link
                href={`/app/${orgSlug}/contacts/${source.contact_person_id}`}
                style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--accent)" }}
                title="Open this account's contact profile"
              >
                Contact →
              </Link>
            ) : null}
            <FeederSourceToggle
              orgSlug={orgSlug}
              instanceId={instanceId}
              rowId={p.id}
              enabled={source?.enabled ?? true}
            />
          </span>
        );
      }}
    />
  );
}
