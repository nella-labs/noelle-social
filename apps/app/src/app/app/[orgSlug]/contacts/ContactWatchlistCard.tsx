import { AppLink as Link } from "@/components/nav/AppLink";
import { type WatchlistObjectiveKind } from "@noelle/contracts";
import { SubmitButton } from "@/components/SubmitButton";
import { ReloadForm } from "@/components/ReloadForm";
import { NO_OBJECTIVE, ObjectiveSelect } from "@/components/watchlist/ObjectiveSelect";
import {
  addWatchlistPerson,
  removeWatchlistPerson,
  setWatchlistPersonObjective,
} from "../agents/[instanceId]/watchlist-people-actions";
import {
  removeLinkedInWatchlistPerson,
  setLinkedInWatchlistPersonObjective,
} from "../agents/[instanceId]/linkedin-watchlist-actions";

/** A watcher row enriched with the agent's URL slug (computed on the page). */
export interface ContactWatcherView {
  /**
   * Which watchlist this row lives on. Both edit inline now, but with different
   * objective shapes: 'x' uses a kind + note, 'linkedin' a single free-text line.
   */
  platform: "x" | "linkedin";
  watchlistRowId: string;
  agentInstanceId: string;
  agentName: string;
  agentSlug: string;
  objectiveKind: WatchlistObjectiveKind | null;
  objectiveNote: string | null;
}

/** An x_intern agent not yet watching this contact — offered in the add form. */
export interface AddableAgent {
  instanceId: string;
  name: string;
}

/**
 * "Watched by" — the watchlist face of a contact, on the Contacts detail page.
 * Contacts is the single combined person surface, so the per-agent always-reply
 * membership (objective + note) is managed right here instead of on a separate
 * agent person page. Each agent that watches this contact gets a row with an
 * editable objective + a remove control; agents that don't yet watch them can
 * be added inline (X-handle contacts only — the watchlist keys on the handle).
 */
export function ContactWatchlistCard({
  orgSlug,
  handle,
  watchers,
  addableAgents,
}: {
  orgSlug: string;
  /** The contact's X handle (lowercased, no @). null ⇒ can't be watchlisted. */
  handle: string | null;
  watchers: ContactWatcherView[];
  addableAgents: AddableAgent[];
}) {
  const canAdd = Boolean(handle) && addableAgents.length > 0;

  return (
    <section className="card">
      <div className="card-h">
        <h3>Watched by</h3>
        <span className="tag">{watchers.length}</span>
      </div>
      <p style={{ fontSize: 12.5, color: "var(--ink-muted)", margin: "0 0 12px" }}>
        Agents that reply (and DM) to every new post this contact makes, from the
        day they were added. Pick an objective to steer how each one engages them.
      </p>

      {watchers.length === 0 ? (
        <div style={{ fontSize: 13, color: "var(--ink-muted)" }}>
          {handle
            ? "Not on any agent’s watchlist yet."
            : "Link an X account to add this contact to an agent’s watchlist."}
        </div>
      ) : (
        <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
          {watchers.map((w) => (
            <li
              key={w.watchlistRowId}
              style={{
                display: "flex",
                flexDirection: "column",
                gap: 6,
                padding: "10px 0",
                borderTop: "1px dashed var(--rule-soft)",
              }}
            >
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <Link
                  href={`/app/${orgSlug}/agents/${w.agentSlug}/watchlist`}
                  className="serif"
                  style={{ fontSize: 15, textDecoration: "none", color: "var(--ink)" }}
                  title="Open this agent’s watchlist"
                >
                  {w.agentName} →
                </Link>
                <ReloadForm
                  action={async () => {
                    "use server";
                    if (w.platform === "x") {
                      await removeWatchlistPerson({
                        orgSlug,
                        instanceId: w.agentInstanceId,
                        rowId: w.watchlistRowId,
                      });
                    } else {
                      await removeLinkedInWatchlistPerson({
                        orgSlug,
                        instanceId: w.agentInstanceId,
                        rowId: w.watchlistRowId,
                      });
                    }
                  }}
                >
                  <SubmitButton className="btn btn-xs" title="Remove from this agent’s watchlist">
                    ×
                  </SubmitButton>
                </ReloadForm>
              </div>
              {w.platform === "x" ? (
                <ReloadForm
                  action={async (fd: FormData) => {
                    "use server";
                    const kindRaw = String(fd.get("objectiveKind") ?? "");
                    await setWatchlistPersonObjective({
                      orgSlug,
                      instanceId: w.agentInstanceId,
                      rowId: w.watchlistRowId,
                      objectiveKind: kindRaw ? (kindRaw as WatchlistObjectiveKind) : null,
                      objectiveNote: String(fd.get("objectiveNote") ?? ""),
                    });
                  }}
                  style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center" }}
                >
                  <ObjectiveSelect name="objectiveKind" defaultValue={w.objectiveKind ?? NO_OBJECTIVE} />
                  <input
                    name="objectiveNote"
                    defaultValue={w.objectiveNote ?? ""}
                    placeholder="optional note"
                    className="input"
                    style={{ flex: "1 1 120px", fontSize: 11.5 }}
                    maxLength={240}
                  />
                  <SubmitButton className="btn btn-xs" title="Save objective">
                    Save
                  </SubmitButton>
                </ReloadForm>
              ) : (
                /* LinkedIn objective is a single free-text steer (no kind) — the
                   LinkedIn drafter reads it raw. Edited inline like the X note. */
                <ReloadForm
                  action={async (fd: FormData) => {
                    "use server";
                    await setLinkedInWatchlistPersonObjective({
                      orgSlug,
                      instanceId: w.agentInstanceId,
                      rowId: w.watchlistRowId,
                      objective: String(fd.get("objective") ?? ""),
                    });
                  }}
                  style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center" }}
                >
                  <input
                    name="objective"
                    defaultValue={w.objectiveNote ?? ""}
                    placeholder="how should Lyra engage them?"
                    className="input"
                    style={{ flex: "1 1 160px", fontSize: 11.5 }}
                    maxLength={240}
                  />
                  <SubmitButton className="btn btn-xs" title="Save objective">
                    Save
                  </SubmitButton>
                </ReloadForm>
              )}
            </li>
          ))}
        </ul>
      )}

      {canAdd ? (
        <ReloadForm
          action={async (fd: FormData) => {
            "use server";
            const instanceId = String(fd.get("instanceId") ?? "");
            if (!instanceId || !handle) return;
            const kindRaw = String(fd.get("objectiveKind") ?? "");
            await addWatchlistPerson({
              orgSlug,
              instanceId,
              handle,
              objectiveKind: kindRaw ? (kindRaw as WatchlistObjectiveKind) : null,
            });
          }}
          style={{
            display: "flex",
            flexWrap: "wrap",
            gap: 8,
            alignItems: "center",
