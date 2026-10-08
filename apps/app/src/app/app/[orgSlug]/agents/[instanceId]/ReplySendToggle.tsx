"use client";

import { useState, useTransition } from "react";
import { setReplySendEnabled } from "./actions";

/**
 * Master "reply sending" switch for an intern instance (Vega / Lyra). OFF by
 * default: replies are still drafted and queued for approval, but nothing posts
 * until this is on. It gates BOTH send paths server-side (the X send worker and
 * the LinkedIn actuator queue), so flipping it off is a real kill switch, not a
 * UI hint. Hard reload on success for the same React-19 fast-action reason as
 * StatusToggleButton.
 */
export function ReplySendToggle({
  orgSlug,
  instanceId,
  enabled,
}: {
  orgSlug: string;
  instanceId: string;
  enabled: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [, startT] = useTransition();

  const label = enabled ? "Sending: ON" : "Sending: OFF";

  function onClick() {
    setBusy(true);
    setError(null);
    startT(async () => {
      try {
        const res = await setReplySendEnabled({ orgSlug, instanceId, enabled: !enabled });
        if (!res.ok) {
          setError(res.error.message);
          setBusy(false);
        } else {
          window.location.reload();
        }
      } catch (err) {
        console.error("[reply-send-toggle] action threw:", err);
        setError("Something went wrong. Try again.");
        setBusy(false);
      }
    });
  }

  return (
    <>
      <button
        type="button"
        className={enabled ? "btn btn-sm btn-primary" : "btn btn-sm"}
        onClick={onClick}
        disabled={busy}
        title={
          enabled
            ? "Replies are posting live. Click to stop sending (drafts still queue for approval)."
            : "Sending is off: replies are drafted and queued but nothing posts. Click to turn sending on."
        }
        aria-label={enabled ? "Turn reply sending off" : "Turn reply sending on"}
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
