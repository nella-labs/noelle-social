import type { LinkedInWatchlistPersonRow } from "@/lib/queries";
import { AGENT_UI } from "@/lib/agent-ui-config";
import {
  WatchlistPeoplePanel,
  type WatchlistPersonView,
} from "@/components/watchlist/WatchlistPeoplePanel";
import {
  addLinkedInWatchlistPerson,
  removeLinkedInWatchlistPerson,
  setLinkedInWatchlistPersonObjective,
} from "./linkedin-watchlist-actions";

/**
 * Watchlist-people card for the LinkedIn intern (Lyra). The LinkedIn analogue of
 * WatchlistCard: same shared panel, but rows are keyed by public_id (no @handle),
 * shown by name + headline, link out to the real LinkedIn profile, and carry a
 * "profiled" badge once the profiler has built a profile. The objective is a
 * single free-text engagement steer (the LinkedIn drafter reads it raw).
 */
export function LinkedInWatchlistCard({
  orgSlug,
  instanceId,
  people,
}: {
  orgSlug: string;
  /** Real instance UUID — used by the add/remove server actions. */
  instanceId: string;
  people: LinkedInWatchlistPersonRow[];
}) {
  const copy = AGENT_UI.linkedin_intern.watchlist;

  const view: WatchlistPersonView[] = people.map((p) => ({
    id: p.id,
    title: p.name ?? p.public_id ?? p.fsd_profile_id,
    subtitle: p.headline,
    href: p.public_id
      ? `https://www.linkedin.com/in/${p.public_id}`
      : `https://www.linkedin.com/search/results/all/?keywords=${encodeURIComponent(p.name ?? "")}`,
    external: true,
    badge: p.profiled ? "profiled" : null,
    objective: p.objective,
  }));

  return (
    <WatchlistPeoplePanel
      people={view}
      title={copy.title}
      helper={copy.helper}
      objective={{ mode: "freetext", placeholder: "optional — how should Lyra engage them?" }}
      add={copy.add ? { field: "publicId", label: copy.add.fieldLabel, placeholder: copy.add.placeholder } : null}
      addAction={async (fd: FormData) => {
        "use server";
        const publicId = String(fd.get("publicId") ?? "");
        if (!publicId) return;
        await addLinkedInWatchlistPerson({
          orgSlug,
          instanceId,
          publicId,
          objective: String(fd.get("objective") ?? ""),
        });
      }}
      removeAction={async (fd: FormData) => {
        "use server";
        await removeLinkedInWatchlistPerson({ orgSlug, instanceId, rowId: String(fd.get("rowId") ?? "") });
      }}
      setObjectiveAction={async (fd: FormData) => {
        "use server";
        await setLinkedInWatchlistPersonObjective({
          orgSlug,
          instanceId,
          rowId: String(fd.get("rowId") ?? ""),
          objective: String(fd.get("objective") ?? ""),
        });
      }}
    />
  );
}
