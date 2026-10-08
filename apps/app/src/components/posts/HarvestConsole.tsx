"use client";

import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import type { HarvestLaneResult, HarvestRunSummary } from "@noelle/contracts";
import type { HarvestRunStatus, HarvestRunState } from "@/lib/video-queries";
import { cancelVideoHarvest } from "@/app/app/[orgSlug]/agents/[instanceId]/video-watchlist-actions";

/**
 * Live harvest console — the answer to "I can't see what went wrong, what
 * didn't, or stop it." Server-renders the last run's outcome from
 * getVideoHarvestStatus, then (while a run is in flight) polls the GET route
 * every 3s so each creator/niche lane fills in as it completes: pulled → kept,
 * *why* clips dropped (min-views floor / top-N cap / off-objective), and any
 * per-lane error. A Stop button flags cancel_requested; the worker bails between
 * pulls. Pure display + one server action — no business logic here.
 */
const POLL_MS = 3000;
const ACTIVE: HarvestRunState[] = ["running", "requested"];

export function HarvestConsole({
  orgSlug,
  instanceId,
  initial,
}: {
  orgSlug: string;
  instanceId: string;
  initial: HarvestRunStatus;
}) {
  const [status, setStatus] = useState<HarvestRunStatus>(initial);
  const [stopping, startStop] = useTransition();
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch(`/api/agents/${instanceId}/harvest-run`, { cache: "no-store" });
      if (res.ok) setStatus((await res.json()) as HarvestRunStatus);
    } catch {
      /* transient — the next tick retries */
    }
  }, [instanceId]);

  // Poll only while a run is active; tear the interval down the moment it settles.
  useEffect(() => {
    const active = ACTIVE.includes(status.state);
    if (active && timer.current == null) {
      timer.current = setInterval(refresh, POLL_MS);
    } else if (!active && timer.current != null) {
      clearInterval(timer.current);
      timer.current = null;
    }
    return () => {
      if (timer.current != null) {
        clearInterval(timer.current);
        timer.current = null;
      }
    };
  }, [status.state, refresh]);

  const onStop = () =>
    startStop(async () => {
      await cancelVideoHarvest({ orgSlug, instanceId });
      await refresh();
    });

  const summary = status.summary;
  const running = ACTIVE.includes(status.state);
  // Nothing worth showing: no run has ever produced a summary and none is queued.
  if (!summary && !running) return null;

  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", marginBottom: summary ? 12 : 0 }}>
        <div style={{ fontSize: 13, fontWeight: 500 }}>Harvest run</div>
        <PhaseBadge state={status.state} summary={summary} />
        {running ? (
          <button
            className="btn btn-sm"
            type="button"
            onClick={onStop}
            disabled={stopping}
            style={{ marginLeft: "auto", color: "var(--danger)" }}
          >
            {stopping ? "stopping…" : "■ Stop"}
          </button>
        ) : null}
      </div>

      {summary?.error ? (
        <div
          style={{
            fontFamily: "var(--mono)", fontSize: 11, color: "var(--danger)",
            background: "color-mix(in oklch, var(--danger) 8%, transparent)",
            borderRadius: 8, padding: "8px 10px", marginBottom: summary.lanes.length ? 12 : 0,
          }}
        >
          ⚠ {summary.error}
        </div>
      ) : null}

      {summary && summary.lanes.length > 0 ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
          {summary.lanes.map((lane, i) => (
            <LaneRow key={`${lane.kind}:${lane.label}:${i}`} lane={lane} nicheMinViews={summary.config?.nicheMinViews ?? 0} />
          ))}
          <div style={{ display: "flex", gap: 8, marginTop: 8, fontFamily: "var(--mono)", fontSize: 10.5, color: "var(--ink-soft)" }}>
            <span>{summary.lanes.length} lanes</span>
            <span>· pulled {summary.totals.pulled}</span>
            <span>· kept {summary.totals.kept}</span>
          </div>
        </div>
      ) : running ? (
        <div style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--ink-muted)" }}>
          starting… lanes will appear as each creator and niche is pulled.
        </div>
      ) : null}
    </div>
  );
}

function PhaseBadge({ state, summary }: { state: HarvestRunState; summary: HarvestRunSummary | null }) {
  const phase = summary?.phase;
  // Lanes that errored (per-lane apify failures) — a partial run stays useful.
  const failed = summary?.lanes.filter((l) => l.error).length ?? 0;
  const kept = summary?.totals.kept ?? 0;
  // Reassure that nothing is lost: surface kept-count on live/stalled runs, and
  // report a finished run honestly as "done · N kept" (+ how many lanes failed).
  const keptTag = kept > 0 ? ` · ${kept} kept` : "";
  const failTag = failed > 0 ? ` · ${failed} lane${failed === 1 ? "" : "s"} failed` : "";
  const label =
    state === "running"
      ? (phase === "creators" ? "pulling creators…" : phase === "niches" ? "pulling niches…" : "harvesting…") + keptTag
      : state === "requested" ? "queued…"
      : state === "stalled" ? `stalled${keptTag} (saved)`
      : phase === "cancelled" ? `stopped${keptTag}`
      : phase === "error" || state === "errored" ? `errored${keptTag}`
      : `done${keptTag}${failTag}`;
  const tone =
    state === "running" || state === "requested" ? "var(--warn)"
    : state === "stalled" || state === "errored" || phase === "error" ? "var(--danger)"
    : phase === "cancelled" ? "var(--ink-muted)"
    : "var(--ok)";
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6, fontFamily: "var(--mono)", fontSize: 10.5, color: "var(--ink-muted)" }}>
      <span style={{ width: 6, height: 6, borderRadius: "50%", background: tone }} />
      {label}
    </span>
  );
}

function LaneRow({ lane, nicheMinViews }: { lane: HarvestLaneResult; nicheMinViews: number }) {
  const drops: string[] = [];
  if (lane.dropped.belowMinViews > 0) drops.push(`${lane.dropped.belowMinViews} < ${fmt(nicheMinViews)} views`);
  if (lane.dropped.notSelected > 0) drops.push(`${lane.dropped.notSelected} past top-N`);
  if (lane.dropped.offObjective > 0) drops.push(`${lane.dropped.offObjective} off-objective`);
  const kept0 = lane.kept === 0 && lane.pulled > 0 && !lane.error;
  return (
    <div
      style={{
        display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap",
        padding: "5px 0", borderBottom: "0.5px solid var(--rule)", fontFamily: "var(--mono)", fontSize: 11,
      }}
    >
      <span style={{ color: "var(--ink-soft)", fontSize: 9.5, minWidth: 44 }}>{lane.kind}</span>
      <span style={{ color: "var(--ink)", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" }}>{lane.label}</span>
      <span style={{ marginLeft: "auto", color: kept0 ? "var(--danger)" : "var(--ink-muted)" }}>
        {lane.pulled} → <strong style={{ color: kept0 ? "var(--danger)" : "var(--ink)" }}>{lane.kept}</strong>
      </span>
      {lane.error ? (
        <span style={{ width: "100%", color: "var(--danger)", fontSize: 10 }}>⚠ {lane.error}</span>
      ) : drops.length > 0 ? (
        <span style={{ width: "100%", color: "var(--ink-soft)", fontSize: 10 }}>dropped: {drops.join(" · ")}</span>
      ) : null}
    </div>
  );
}

function fmt(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n % 1_000 === 0 ? 0 : 1)}k`;
  return String(n);
}
