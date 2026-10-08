"use client";

import { useEffect, useState, useTransition } from "react";
import { setActuatorDesiredState } from "./actions";

/**
 * Remote start/stop of the browser actuator (the "hands") — the phone-facing
 * control. Flips agent_instances.actuator_desired_state (0089); the extension
 * long-polls it and reconciles within ~1s. 'running' = run persistently
 * (Full-automatic); 'stopped' = fully pause (ends any live run + gates autonomy).
 *
 * 'running' is "hands ALLOWED to run", NOT send-consent: on X, replies still only
 * post when the separate Sending switch (reply_send_enabled) is on — so starting
 * here never silently begins posting. The sub-line reflects the extension's OWN
 * reported state + liveness, so a tap shows whether it actually reached the hands.
 * Hard reload on success, same React-19 fast-action reason as StatusToggleButton.
 */
export function ActuatorPowerToggle({
  orgSlug,
  instanceId,
  desired,
  lastState,
  seenAt,
}: {
  orgSlug: string;
  instanceId: string;
  desired: "running" | "stopped" | null;
  lastState: "running" | "idle" | null;
  seenAt: string | null;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [, startT] = useTransition();

  // Relative "seen …" is time-dependent, so compute it only after mount to avoid
  // an SSR/client hydration mismatch. The tick counter forces a re-render every 5s
  // so "offline" appears on its own once the ack goes stale.
  const [mounted, setMounted] = useState(false);
  const [, setTick] = useState(0);
  useEffect(() => {
    setMounted(true);
    const t = setInterval(() => setTick((n) => n + 1), 5000);
    return () => clearInterval(t);
  }, []);

  const running = desired === "running";
  const next: "running" | "stopped" = running ? "stopped" : "running";
  const label = desired === null ? "Hands: —" : running ? "Hands: RUNNING" : "Hands: STOPPED";

  function onClick() {
    setBusy(true);
    setError(null);
    startT(async () => {
      try {
        const res = await setActuatorDesiredState({ orgSlug, instanceId, desired: next });
        if (!res.ok) {
          setError(res.error.message);
          setBusy(false);
        } else {
          window.location.reload();
        }
      } catch (err) {
        console.error("[actuator-power-toggle] action threw:", err);
        setError("Something went wrong. Try again.");
        setBusy(false);
      }
    });
  }

  return (
    <>
      <button
        type="button"
        className={running ? "btn btn-sm btn-primary" : "btn btn-sm"}
        onClick={onClick}
        disabled={busy}
        title={
          running
            ? "The actuator is set to run. Click to STOP it — ends any live run and keeps the hands paused until you start again."
            : "The actuator is stopped. Click to START it (Full-automatic). Note: replies still only post if Sending is also on."
        }
        aria-label={running ? "Stop the actuator" : "Start the actuator"}
      >
        {busy ? "…" : label}
      </button>
      {mounted ? (
        <span className="mono" style={{ fontSize: 11, opacity: 0.7 }}>
          {actualLabel(lastState, seenAt)}
        </span>
      ) : null}
      {error ? (
        <span className="mono" style={{ color: "var(--danger)", fontSize: 11 }}>
          {error}
        </span>
      ) : null}
    </>
  );
}

// The extension acks its real run state on every reconcile; treat it as live only
// if that ack is recent, so a closed browser (no polling) reads "offline" instead
// of a stale "running". Kept generous (~90s) vs the ~25s long-poll cadence.
const LIVE_WINDOW_MS = 90_000;

function actualLabel(lastState: "running" | "idle" | null, seenAt: string | null): string {
  if (!seenAt) return "· never connected";
  const ageMs = Date.now() - Date.parse(seenAt);
  if (!Number.isFinite(ageMs)) return "· never connected";
  if (ageMs > LIVE_WINDOW_MS) return `· offline (seen ${ago(ageMs)})`;
  return lastState === "running" ? "· live · running" : "· live · idle";
}

function ago(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  return `${Math.round(m / 60)}h ago`;
}
