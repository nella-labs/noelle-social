"use client";

import { useState, useTransition } from "react";
import { pauseAllSending } from "./actions";

/**
 * One-tap global "Pause all sending" panic control for the org, mounted in the
 * approvals header. Clears master sending and every sending-consent flag for
 * supported interns in one scoped update. Writes already dispatched may finish.
 * Deliberately asymmetric — there is NO resume affordance here;
 * re-arming stays per-intern so a pause can't be
 * casually undone. window.confirm gate + a live-announced result. Hard reload
 * on success so every "Sending: ON/OFF" chip on the page reflects the new
 * state (same React-19 fast-action reason as ReplySendToggle).
 */
export function PauseAllButton({ orgSlug }: { orgSlug: string }) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [, startT] = useTransition();

  function onClick() {
    if (
      !window.confirm(
        "Pause sending for every intern in this org?\n\nThis turns off master sending, reply sending, autopilot and X API writes. Drafts keep queuing. Writes already in flight may finish. Re-enable each intern's sending controls individually afterward.",
      )
    )
      return;
    setBusy(true);
    setError(null);
    setMsg(null);
    startT(async () => {
      try {
        const res = await pauseAllSending({ orgSlug });
        if (!res.ok) {
          setError(res.error.message);
          setBusy(false);
          return;
        }
        // Show the count, then hard reload so every "Sending: ON/OFF" chip on
        // the page reflects the new state (same reason as ReplySendToggle).
        setMsg(
          res.paused === 0
            ? "All sending was already paused."
            : `All sending paused (${res.paused} intern${res.paused === 1 ? "" : "s"}).`,
        );
        setTimeout(() => window.location.reload(), 400);
      } catch (err) {
        console.error("[pause-all] action threw:", err);
        setError(
          "Something went wrong — sending may still be on. Retry or pause each intern.",
        );
        setBusy(false);
      }
    });
  }

  return (
    <>
      <button
        type="button"
        className="btn btn-sm"
        style={{ color: "var(--danger)" }}
        onClick={onClick}
        disabled={busy}
        title="Pause master sending and all intern sending consents. Writes already in flight may finish."
        aria-label="Pause all sending for every intern in this org"
      >
        {busy ? "Pausing…" : "⏸ Pause all sending"}
      </button>
      {/* Result is announced to assistive tech: success is polite, a failure
          (sending may still be live) is assertive so it isn't missed. */}
      <span role="status" aria-live="polite">
        {msg ? (
          <span className="mono" style={{ color: "var(--warn)", fontSize: 11 }}>
            {msg}
          </span>
        ) : null}
      </span>
      <span role="alert" aria-live="assertive">
        {error ? (
          <span className="mono" style={{ color: "var(--danger)", fontSize: 11 }}>
            {error}
          </span>
        ) : null}
      </span>
    </>
  );
}
