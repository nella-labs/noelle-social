"use client";

import { useEffect, useState, useTransition } from "react";
import { requestFeederRun } from "./actions";
import type { FeederRunStatus, FeederRunState } from "@/lib/feeder-queries";

/**
 * Compact relative time against a client-ticking `now`. `now` is null until the
 * component has mounted on the client — during SSR and the first client render
 * we return a stable placeholder so the markup matches exactly (a render-time
 * Date.now() here would mismatch hydration and kill the page; see PipelinePanel).
 */
function rel(ts: string | null, now: number | null): string {
  if (!ts || now == null) return "—";
  const s = Math.max(0, Math.floor((now - new Date(ts).getTime()) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

const STATE_UI: Record<FeederRunState, { dot: string; label: string }> = {
  running: { dot: "dot dot-ok", label: "running" },
  requested: { dot: "dot dot-warn", label: "pull requested" },
  stalled: { dot: "dot dot-warn", label: "stalled" },
  errored: { dot: "dot dot-warn", label: "errored" },
  idle: { dot: "dot dot-mute", label: "idle" },
};

/**
 * The cost-gated Run card. The button flips account_feeder_run_requested_at via
 * the requestFeederRun server action; the F5 worker polls that flag and does the
 * actual (paid) Apify + Gemini pull on its next tick. Because the pull costs real
 * money, the button requires an explicit confirm step and shows a clear cost
 * warning + the per-source estimate.
 *
 * Busy/reload: uses the run() busy + window.location.reload() pattern (NOT
 * router.refresh()) to dodge the React-19 fast-action reconciler race that
 * wedges every later action until a hard reload. See PipelinePanel.run().
 */
export function FeederRunCard({
  orgSlug,
  instanceId,
  status,
  enabledSourceCount,
}: {
  orgSlug: string;
  instanceId: string;
  status: FeederRunStatus;
  /** Enabled sources — drives the cost estimate + the empty-state guard. */
  enabledSourceCount: number;
}) {
  // null until mounted on the client — see rel(). Avoids a hydration mismatch.
  const [now, setNow] = useState<number | null>(null);
  const [pending, startT] = useTransition();
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  // A pull is "in flight" when the worker is actively running it OR a request is
  // sitting on the flag waiting to be picked up. Disable the button in both so we
  // never stack requests.
  const inFlight = status.state === "running" || status.state === "requested";
  const canRun = enabledSourceCount > 0 && !inFlight && !pending;
  const ui = STATE_UI[status.state];

  function doRun() {
    setBusy(true);
    setError(null);
    setConfirming(false);
    startT(async () => {
      try {
        const res = await requestFeederRun({ orgSlug, instanceId });
        if (!res.ok) {
          setError(res.error?.message ?? "Something went wrong.");
        } else {
          // Full reload, NOT router.refresh(): a soft refresh hits the React 19
          // fast-action reconciler race (works once, then every button is dead
          // until reload). A hard reload recreates React so the state reflects.
          window.location.reload();
        }
      } catch (err) {
        console.error("[feeder] run request threw:", err);
        setError("Something went wrong. Try again in a moment.");
      } finally {
        setBusy(false);
      }
    });
  }

  // ~30¢–$1 of Apify per source for posts + authored comments (≈$2/1k items),
  // plus a few cents of Gemini extraction. Rounded to a friendly per-source band.
  const estLow = (enabledSourceCount * 0.3).toFixed(2);
  const estHigh = (enabledSourceCount * 1.0).toFixed(2);

  return (
    <section className="card">
      <div className="card-h">
        <h3>Run the feeder</h3>
        <span className="tag">
          <span className={ui.dot} /> {ui.label}
        </span>
      </div>

      <p style={{ fontSize: 12.5, color: "var(--ink-muted)", margin: "0 0 12px" }}>
        Pulls every enabled source account&apos;s recent posts + authored comments,
        scores them by engagement, and distils each into a style profile the
        drafter samples. This is a manual, on-demand pull — nothing runs on a
        schedule.
      </p>

      {/* Cost warning — this is the deliberate cost gate (spec §8). */}
      <div
        style={{
          padding: 12,
          borderRadius: 10,
          background: "var(--paper-2)",
          boxShadow: "0 0 0 0.5px var(--rule-soft)",
          marginBottom: 14,
        }}
      >
        <div style={{ fontSize: 12.5, fontWeight: 600, color: "var(--warn)" }}>
          ⚠ This triggers a paid pull
        </div>
        <div style={{ fontSize: 11.5, color: "var(--ink-muted)", marginTop: 4, lineHeight: 1.45 }}>
          A run bills your Apify account (~$2 / 1,000 items) for each source&apos;s
          posts + comments, then runs a Gemini extraction per account. There are
          no automatic runs — every pull is one you start here.
        </div>
        <div
          style={{
            fontSize: 11,
            color: "var(--ink-soft)",
            marginTop: 8,
            fontFamily: "var(--mono)",
          }}
        >
          {enabledSourceCount === 0
            ? "0 enabled sources — add at least one above to run."
            : `${enabledSourceCount} enabled source${enabledSourceCount === 1 ? "" : "s"} · est. $${estLow}–$${estHigh} Apify`}
        </div>
      </div>

      {/* Two-step confirm so a stray click never starts a paid pull. */}
      <div
        className="action-bar-phone"
        style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}
      >
        {!confirming ? (
          <button
            type="button"
            className="btn btn-sm btn-primary action-bar-primary w-full-phone"
            onClick={() => {
              setError(null);
              setConfirming(true);
            }}
            disabled={!canRun}
            title={
              enabledSourceCount === 0
                ? "Add an enabled source first"
                : inFlight
                  ? "A pull is already in progress"
                  : undefined
            }
          >
            {inFlight ? "Pull in progress…" : "▶ Run pull"}
          </button>
        ) : (
          <>
            <button
              type="button"
              className="btn btn-sm btn-primary action-bar-primary w-full-phone"
              onClick={doRun}
              disabled={pending || busy}
            >
              {pending || busy ? "…" : `Yes, run pull (~$${estLow}–$${estHigh})`}
            </button>
            <button
              type="button"
              className="btn btn-sm w-full-phone"
              onClick={() => setConfirming(false)}
              disabled={pending || busy}
            >
              Cancel
            </button>
          </>
        )}
      </div>

      <div
        style={{ fontSize: 11, color: "var(--ink-soft)", fontFamily: "var(--mono)", marginTop: 10 }}
      >
        Last pulled: {rel(status.lastRunAt, now)}
        {inFlight ? " · pull running, this can take a minute…" : null}
