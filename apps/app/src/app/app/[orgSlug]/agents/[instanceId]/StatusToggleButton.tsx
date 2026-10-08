"use client";

import { useState, useTransition } from "react";
import { toggleAgentStatus } from "./actions";

/**
 * A real Start ⇄ Pause power switch for an intern instance (Vega / Lyra / Orion).
 * Flips `agent_instances.status` active⇄paused via the role-agnostic
 * `toggleAgentStatus` action — the same persistent on/off the other interns get,
 * surfaced for all three (it had no caller before).
 *
 * On success it does a FULL reload, not `router.refresh()`: a soft refresh hits
 * the React 19 fast-action reconciler race (works once, then every button is
 * dead until reload). PipelinePanel uses the same hard-reload for the same
 * reason. Errors surface inline and clear the busy state so the button never
 * gets stuck on "…".
 */
export function StatusToggleButton({
  orgSlug,
  instanceId,
  status,
}: {
  orgSlug: string;
  instanceId: string;
  status: string;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [, startT] = useTransition();

  const isActive = status === "active";
  const next = isActive ? "paused" : "active";
  const label = isActive ? "Pause" : "▶ Start";

  function onClick() {
    setBusy(true);
    setError(null);
    startT(async () => {
      try {
        const res = await toggleAgentStatus({ orgSlug, instanceId, nextStatus: next });
        if (!res.ok) {
          setError(res.error.message);
          setBusy(false);
        } else {
          window.location.reload();
        }
      } catch (err) {
        console.error("[status-toggle] action threw:", err);
        setError("Something went wrong. Try again.");
        setBusy(false);
      }
    });
  }

  return (
    <>
      <button
        type="button"
        className={isActive ? "btn btn-sm" : "btn btn-sm btn-primary"}
        onClick={onClick}
        disabled={busy}
        title={
          isActive
            ? "Pause this agent — stops discovery, classifier and drafter"
            : "Start this agent — resumes discovery, classifier and drafter"
        }
        aria-label={isActive ? "Pause agent" : "Start agent"}
      >
        {busy ? "…" : label}
      </button>
      {error ? (
        <span className="mono" style={{ color: "var(--danger)", fontSize: 11 }}>
          {error}
        </span>
      ) : null}
    </>
  );
}
