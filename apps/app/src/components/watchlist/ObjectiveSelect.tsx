import { WATCHLIST_OBJECTIVES } from "@noelle/contracts";

/** Empty option value — "no objective" (the agent's instance default applies). */
export const NO_OBJECTIVE = "";

/**
 * Preset-objective picker for a watchlisted person. Shared by the agent
 * WatchlistCard and the Contacts "Watched by" card so the option set lives in
 * one place. `value=""` means no objective.
 */
export function ObjectiveSelect({
  name,
  defaultValue,
}: {
  name: string;
  defaultValue: string;
}) {
  return (
    <select
      name={name}
      defaultValue={defaultValue}
      className="input"
      style={{ flex: "1 1 auto", minWidth: 0, fontSize: 12 }}
      aria-label="Objective for this person"
    >
      <option value={NO_OBJECTIVE}>No objective</option>
      {WATCHLIST_OBJECTIVES.map((o) => (
        <option key={o.key} value={o.key}>
          {o.label}
        </option>
      ))}
    </select>
  );
}
