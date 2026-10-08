"use client";

import { useState, useTransition } from "react";
import { toggleFeederSource } from "./actions";

/**
 * Per-source enable/disable switch. A disabled source is skipped on the next
 * feeder run but keeps its corpus. Uses the busy + hard-reload pattern (NOT
 * router.refresh()) to dodge the React-19 fast-action reconciler race, matching
 * the rest of the dashboard's manual actions.
 */
export function FeederSourceToggle({
  orgSlug,
  instanceId,
  rowId,
  enabled,
}: {
  orgSlug: string;
  instanceId: string;
  rowId: string;
  enabled: boolean;
}) {
  const [pending, startT] = useTransition();
  const [busy, setBusy] = useState(false);

  function toggle() {
    setBusy(true);
    startT(async () => {
      try {
        const res = await toggleFeederSource({
          orgSlug,
          instanceId,
          rowId,
          enabled: !enabled,
        });
        if (res.ok) window.location.reload();
      } catch (err) {
        console.error("[feeder] toggle threw:", err);
      } finally {
        setBusy(false);
      }
    });
  }

  return (
    <button
      type="button"
      className={`btn btn-xs ${enabled ? "btn-primary" : ""}`}
      onClick={toggle}
      disabled={pending || busy}
      aria-pressed={enabled}
      title={enabled ? "Enabled — pulled on the next run. Click to skip." : "Disabled — skipped. Click to enable."}
    >
      {pending || busy ? "…" : enabled ? "On" : "Off"}
    </button>
  );
}
