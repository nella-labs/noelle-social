import type { WatchlistObjectiveKind } from "@noelle/contracts";
import type { WatchlistPersonRow } from "@/lib/queries";
import { AGENT_UI } from "@/lib/agent-ui-config";
import {
  WatchlistPeoplePanel,
  type WatchlistPersonView,
} from "@/components/watchlist/WatchlistPeoplePanel";
import {
  addWatchlistPerson,
  removeWatchlistPerson,
  setWatchlistPersonObjective,
} from "./watchlist-people-actions";

/**
 * Watchlist-people card for the X intern (Vega). A thin wrapper that binds the
 * X server actions + normalises x_watchlist_people rows onto the shared
 * WatchlistPeoplePanel. People here get a reply (+ DM) to every new post they
 * make from the day they're added, bypassing the classifier + drafter gates;
 * the per-person preset objective steers HOW Vega drafts for them.
 */
export function WatchlistCard({
  orgSlug,
  instanceId,
  slug,
  people,
}: {
  orgSlug: string;
  /** Real instance UUID — used by the add/remove server actions. */
  instanceId: string;
  /** URL slug for the agent — used to build the person-detail href. */
  slug: string;
  people: WatchlistPersonRow[];
}) {
  const copy = AGENT_UI.x_intern.watchlist;

  const view: WatchlistPersonView[] = people.map((p) => ({
    id: p.id,
    title: `@${p.handle}`,
    href: `/app/${orgSlug}/agents/${slug}/person/${p.handle}`,
    objectiveKind: p.objective_kind,
    objectiveNote: p.objective_note,
  }));

  return (
    <WatchlistPeoplePanel
      people={view}
      title={copy.title}
      helper={copy.helper}
      objective={{ mode: "preset" }}
      presetAddDefault="relationship"
      add={copy.add ? { field: "handle", label: copy.add.fieldLabel, placeholder: copy.add.placeholder } : null}
      addAction={async (fd: FormData) => {
        "use server";
        const handle = String(fd.get("handle") ?? "");
        if (!handle) return;
        const kindRaw = String(fd.get("objectiveKind") ?? "");
        await addWatchlistPerson({
          orgSlug,
          instanceId,
          handle,
          objectiveKind: kindRaw ? (kindRaw as WatchlistObjectiveKind) : null,
          objectiveNote: String(fd.get("objectiveNote") ?? ""),
        });
      }}
      removeAction={async (fd: FormData) => {
        "use server";
        await removeWatchlistPerson({ orgSlug, instanceId, rowId: String(fd.get("rowId") ?? "") });
      }}
      setObjectiveAction={async (fd: FormData) => {
        "use server";
        const kindRaw = String(fd.get("objectiveKind") ?? "");
        await setWatchlistPersonObjective({
          orgSlug,
          instanceId,
          rowId: String(fd.get("rowId") ?? ""),
          objectiveKind: kindRaw ? (kindRaw as WatchlistObjectiveKind) : null,
          objectiveNote: String(fd.get("objectiveNote") ?? ""),
        });
      }}
    />
  );
}
