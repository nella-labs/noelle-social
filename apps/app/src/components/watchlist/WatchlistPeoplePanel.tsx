import type { ReactNode } from "react";
import { AppLink as Link } from "@/components/nav/AppLink";
import { WATCHLIST_OBJECTIVES, type WatchlistObjectiveKind } from "@noelle/contracts";
import { SubmitButton } from "@/components/SubmitButton";
import { ReloadForm } from "@/components/ReloadForm";

const NO_OBJECTIVE = "";

/**
 * A watched person, normalised so one panel renders both interns:
 *  - Vega (X):   title = @handle, links to the in-app person page, preset objective.
 *  - Lyra (LI):  title = name, subtitle = headline, links out to the LinkedIn
 *                profile, free-text objective, optional "profiled" badge.
 */
export interface WatchlistPersonView {
  id: string;
  /** Primary label (handle for X, name/slug for LinkedIn). */
  title: string;
  /** Optional secondary line (LinkedIn headline). */
  subtitle?: string | null;
  /** Link target for the title. */
  href: string;
  /** Open the title link in a new tab (external LinkedIn profile). */
  external?: boolean;
  /** Optional small status badge, e.g. "profiled". */
  badge?: string | null;
  /** Current objective — preset mode (X). */
  objectiveKind?: WatchlistObjectiveKind | null;
  objectiveNote?: string | null;
  /** Current objective — free-text mode (LinkedIn). */
  objective?: string | null;
  /** Dim the row (e.g. a disabled source the next run will skip). */
  dimmed?: boolean;
}

/** How the objective is stored/edited for this intern. */
export type ObjectiveControl =
  | { mode: "preset" }
  | { mode: "freetext"; placeholder?: string }
  | { mode: "none" };

type ServerFormAction = (formData: FormData) => Promise<unknown> | unknown;

/**
 * Shared watchlist-people editor for both interns. Platform differences come in
 * as props (normalised people, copy, objective mode, and pre-bound server
 * actions) so the component itself is agent-agnostic — the X and LinkedIn cards
 * are thin wrappers that bind their own actions + normalise their own rows.
 */
export function WatchlistPeoplePanel({
  people,
  title,
  helper,
  objective,
  add,
  presetAddDefault = NO_OBJECTIVE,
  addAction,
  removeAction,
  setObjectiveAction,
  renderRowActions,
}: {
  people: WatchlistPersonView[];
  title: string;
  helper: string;
  objective: ObjectiveControl;
  /** Manual-add form config, or null to hide it. `field` is the identifier input. */
  add: { field: string; label: string; placeholder: string } | null;
  /** Preset mode only: the objective a freshly-added person defaults to. */
  presetAddDefault?: string;
  /** Add: reads the identifier (`add.field`) + objective fields from FormData. */
  addAction?: ServerFormAction;
  /** Remove: reads a hidden `rowId` from FormData. */
  removeAction: ServerFormAction;
  /** Set objective: reads a hidden `rowId` + objective fields from FormData. */
  setObjectiveAction?: ServerFormAction;
  /**
   * Optional per-row control rendered before the remove button (e.g. an
   * enable/disable toggle for feeder sources). Kept generic so the panel stays
   * agent-agnostic.
   */
  renderRowActions?: (person: WatchlistPersonView) => ReactNode;
}) {
  return (
    <section className="card">
      <div className="card-h">
        <h3>{title}</h3>
        <span className="tag">{people.length}</span>
      </div>
      <p style={{ fontSize: 12.5, color: "var(--ink-muted)", margin: "0 0 12px" }}>
        {helper}
      </p>

      {add && addAction ? (
        <ReloadForm
          action={addAction}
          style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 14 }}
        >
          <input
            name={add.field}
            placeholder={add.placeholder}
            aria-label={add.label}
            className="input"
            style={{ flex: "1 1 160px" }}
            required
            maxLength={200}
          />
          <ObjectiveFields objective={objective} kind={presetAddDefault} />
          <SubmitButton className="btn btn-sm btn-accent">Add</SubmitButton>
        </ReloadForm>
      ) : null}

      <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
        {people.map((p) => (
          <li
            key={p.id}
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 6,
              padding: "10px 0",
              borderTop: "1px dashed var(--rule-soft)",
              opacity: p.dimmed ? 0.55 : 1,
            }}
          >
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
              <div style={{ display: "flex", flexDirection: "column", gap: 1, minWidth: 0 }}>
                <Link
                  href={p.href}
                  {...(p.external ? { target: "_blank", rel: "noreferrer" } : {})}
                  style={{ fontSize: 12.5, textDecoration: "none", color: "var(--ink)", fontWeight: 500 }}
                  title="View profile + interaction history"
                >
                  {p.title} →
                </Link>
                {p.subtitle ? (
                  <span style={{ fontSize: 11, color: "var(--ink-muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {p.subtitle}
                  </span>
                ) : null}
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 6, flexShrink: 0 }}>
                {p.badge ? (
                  <span className="tag" style={{ fontSize: 10 }}>{p.badge}</span>
                ) : null}
                {renderRowActions ? renderRowActions(p) : null}
                <ReloadForm action={removeAction}>
                  <input type="hidden" name="rowId" value={p.id} />
                  <SubmitButton className="btn btn-xs" title="Remove from watchlist">×</SubmitButton>
                </ReloadForm>
              </div>
            </div>
            {objective.mode !== "none" && setObjectiveAction ? (
              <ReloadForm
                action={setObjectiveAction}
                style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center" }}
              >
                <input type="hidden" name="rowId" value={p.id} />
                <ObjectiveFields
                  objective={objective}
                  kind={p.objectiveKind ?? NO_OBJECTIVE}
                  note={p.objectiveNote ?? ""}
                  freetextValue={p.objective ?? ""}
                />
                <SubmitButton className="btn btn-xs" title="Save objective">Save</SubmitButton>
              </ReloadForm>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * The objective inputs for the active mode, used in both the add form (empty
 * values) and each person row (current values). Preset = dropdown + note;
 * freetext = single input; none = nothing.
 */
function ObjectiveFields({
  objective,
  kind = NO_OBJECTIVE,
  note = "",
  freetextValue = "",
}: {
  objective: ObjectiveControl;
  kind?: string;
  note?: string;
  freetextValue?: string;
}) {
  if (objective.mode === "preset") {
    return (
      <>
        <ObjectiveSelect name="objectiveKind" defaultValue={kind} />
        <input
          name="objectiveNote"
          defaultValue={note}
          placeholder="optional note"
          className="input"
          style={{ flex: "1 1 120px", fontSize: 11.5 }}
          maxLength={240}
