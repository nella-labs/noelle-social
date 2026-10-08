"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { ReviewFriendlyDmsLink } from "@/components/approvals/DmVisibilityControl";
import {
  startAll,
  stopAll,
  setWorkerEnabled,
  setRunSchedule,
  setRelationshipDmsEnabled,
} from "./actions";
import { RELATIONSHIP_DM_DAILY_CAPS, type DiscoveryConfig } from "@noelle/contracts";
import {
  AGENT_UI,
  type InternRole,
  type PipelineUi,
  type TailorNumberField,
} from "@/lib/agent-ui-config";
import type {
  PipelineSnapshot,
  PipelineScheduleSnapshot,
  PipelineWorkerSnapshot,
  VegaWorkerState,
} from "@/lib/queries";

const LABEL: Record<string, string> = {
  discovery: "Discovery",
  classifier: "Classifier",
  drafter: "Drafter",
  send: "Send",
  profiler: "Profiler",
  watchlist: "Watchlist",
};
const VERB: Record<string, string> = {
  discovery: "discovered",
  classifier: "classified",
  drafter: "drafted",
  send: "sent",
  profiler: "profiled",
  watchlist: "queued",
};
// One-line role so the On/Off switch is legible — e.g. it's not obvious that
// "Drafter" is the reply-generation switch you flip to stop spend. The drafter
// line is agent-specific (Vega posts; Lyra drafts only) and comes from the
// PipelineUi config; the rest are the same for both interns.
const ROLE: Record<string, string> = {
  discovery: "finds new posts to reply to",
  classifier: "scores + filters the leads",
  drafter: "generates the replies + DMs",
  send: "posts approved replies to X",
  profiler: "builds watchlist profiles",
  watchlist: "always-on replies to watched people",
};
const STATE: Record<VegaWorkerState, { dot: string; label: string; tone: string }> = {
  running: { dot: "dot dot-ok", label: "running", tone: "var(--ok)" },
  idle: { dot: "dot dot-mute", label: "idle", tone: "var(--ink-muted)" },
  stalled: { dot: "dot dot-warn", label: "stalled", tone: "var(--warn)" },
  errored: { dot: "dot dot-warn", label: "errored", tone: "var(--warn)" },
  disabled: { dot: "dot dot-mute", label: "off", tone: "var(--ink-soft)" },
};

/**
 * Compact relative time against a client-ticking `now`. `now` is null until the
 * component has mounted on the client — during SSR and the first client render
 * we return a stable placeholder so the markup matches exactly (a render-time
 * Date.now() here would mismatch hydration and kill the whole page).
 */
function rel(ts: string | null, now: number | null): string {
  if (!ts || now == null) return "—";
  const s = Math.max(0, Math.floor((now - new Date(ts).getTime()) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}
// Deterministic thousands separator — NOT toLocaleString() (locale differs
// server vs client → hydration mismatch).
const fmt = (n: number) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
// number | null | undefined → controlled-input string ("" for unset).
const numStr = (n: number | null | undefined) => (n == null ? "" : String(n));

export function PipelinePanel({
  orgSlug,
  instanceId,
  snapshot,
  agentRole,
  relationshipDms,
}: {
  orgSlug: string;
  instanceId: string;
  snapshot: PipelineSnapshot;
  /** Drives the agent-specific copy + which "Tailor this run" fields apply. */
  agentRole: InternRole;
  relationshipDms?: {
    platform: "linkedin" | "x";
    enabled: boolean;
    approvalsHref: string;
  };
}) {
  const ui = AGENT_UI[agentRole].pipeline;
  const router = useRouter();
  // null until mounted on the client — see rel(). Avoids a hydration mismatch.
  const [now, setNow] = useState<number | null>(null);
  const [pending, startT] = useTransition();
  const [busy, setBusy] = useState<string | null>(null);
  const [goalInput, setGoalInput] = useState(20);
  const [error, setError] = useState<string | null>(null);

  // "Tailor this run" — the saved default prefills the form; on Start all we
  // send the full picture as a per-run override (null = filter off). null
  // discoveryConfig means this intern doesn't support tailoring at all. The form
  // fields themselves come from the agent's PipelineUi config (X vs LinkedIn).
  const dc = snapshot.discoveryConfig;
  const dcRecord = (dc ?? {}) as Record<string, unknown>;
  const [tailorOpen, setTailorOpen] = useState(false);
  const [nums, setNums] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      ui.tailorFields.map((f) => [f.key, numStr(dcRecord[f.key] as number | null | undefined)]),
    ),
  );
  const [bools, setBools] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(ui.tailorBooleans.map((b) => [b.key, Boolean(dcRecord[b.key])])),
  );
  const [lang, setLang] = useState<string>((dc?.lang as string | undefined) ?? "");

  const setNum = (key: string, v: string) => setNums((s) => ({ ...s, [key]: v }));
  const setBool = (key: string, v: boolean) => setBools((s) => ({ ...s, [key]: v }));

  // Build the complete run override from the form. Empty numeric → null ("off"),
  // except non-nullable fields (postsPerSource) which fall back to the saved
  // default. Only the fields this agent's config exposes are included — values
  // are clamped to each field's bounds so the server never 400s.
  function buildRunConfig(): DiscoveryConfig | undefined {
    if (dc == null) return undefined;
    const out: Record<string, unknown> = {};
    for (const f of ui.tailorFields) {
      const raw = (nums[f.key] ?? "").trim();
      const clamped =
        raw === "" ? null : Math.max(f.min, Math.min(f.max, Math.round(Number(raw) || 0)));
      out[f.key] = f.nullable
        ? clamped
        : clamped ?? (dcRecord[f.key] as number | undefined) ?? f.min;
    }
    for (const b of ui.tailorBooleans) out[b.key] = bools[b.key] ?? false;
    if (ui.tailorLang) {
      const lc = lang.trim().toLowerCase();
      out.lang = /^[a-z]{2}$/.test(lc) ? lc : null;
    }
    return out as DiscoveryConfig;
  }

  const active = snapshot.status === "active";
  const goal = snapshot.goal;
  const goalActive = goal.target != null;
  // A real pipeline session (Start all stamped pipeline_started_at). Without it,
  // "since this run" would equal lifetime, so only show it for a real session.
  const sessionStarted = snapshot.pipelineStartedAt != null;

  // Live ticking clock for the timers — starts AFTER mount (free, no server hit).
  useEffect(() => {
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  // Cheap auto-refresh: 60s while a goal-run is active, else 10 min.
  useEffect(() => {
    const ms = goalActive ? 60_000 : 10 * 60_000;
    const t = setInterval(() => router.refresh(), ms);
    return () => clearInterval(t);
  }, [goalActive, router]);

  function run(key: string, fn: () => Promise<{ ok: boolean; error?: { message: string } }>) {
    setBusy(key);
    setError(null);
    startT(async () => {
      try {
        const res = await fn();
        if (!res.ok) setError(res.error?.message ?? "Something went wrong.");
        // Full reload, NOT router.refresh(): a soft refresh hits the React 19
        // fast-action reconciler race (works once, then every button is dead
        // until reload). A hard reload recreates React so every action reflects.
        else window.location.reload();
      } catch (err) {
        // A thrown action (e.g. a transient DB error) would otherwise leave
        // the button stuck on "…" forever with nothing in the console — the
        // exact "button does nothing" symptom. Always clear busy + surface it.
        console.error("[pipeline] action threw:", err);
        setError("Something went wrong. Try again in a moment.");
      } finally {
        setBusy(null);
      }
    });
  }

  const goalPct =
    goalActive && goal.target ? Math.min(100, Math.round((goal.produced / goal.target) * 100)) : 0;

  return (
    <section
      className="card"
      style={{ opacity: active ? 1 : 0.92, position: "relative" }}
    >
      {/* Master header */}
      <div className="card-h">
        <h3>
          Pipeline ·{" "}
          <span style={{ color: active ? "var(--ok)" : "var(--ink-soft)", fontFamily: "var(--mono)", fontSize: 12 }}>
            {active ? "ACTIVE" : "PAUSED"}
          </span>
        </h3>
        <div style={{ display: "flex", gap: 6 }}>
          <button
            type="button"
            className="btn btn-xs"
            onClick={() => run("refresh", async () => ({ ok: true }))}
            disabled={pending}
            title="Refresh counts now"
          >
            ↻
          </button>
          {active ? (
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => run("stop", () => stopAll({ orgSlug, instanceId }))}
              disabled={pending}
            >
              {busy === "stop" ? "…" : "Stop all"}
            </button>
          ) : null}
        </div>
      </div>

      {/* Goal-run */}
      <div
        style={{
          padding: 12,
          borderRadius: 10,
          background: "var(--paper-2)",
          boxShadow: "0 0 0 0.5px var(--rule-soft)",
          marginBottom: 14,
        }}
      >
        {goalActive ? (
          <>
            <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 6 }}>
              <div style={{ fontSize: 14, fontWeight: 500 }}>
                {fmt(goal.produced)} / {fmt(goal.target ?? 0)} leads ready
              </div>
              <div style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--ink-soft)" }}>
                started {rel(goal.startedAt, now)} ago
              </div>
            </div>
            <div style={{ height: 8, borderRadius: 999, background: "var(--rule-soft)", overflow: "hidden" }}>
              <div style={{ width: `${goalPct}%`, height: "100%", background: "var(--ok)", transition: "width .4s" }} />
            </div>
            <div style={{ fontSize: 11.5, color: "var(--ink-muted)", marginTop: 6 }}>
              Auto-pauses at {fmt(goal.target ?? 0)}. {fmt(goal.ready)} currently waiting in the approval queue.
            </div>
          </>
        ) : (
          <>
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              <span style={{ fontSize: 13.5 }}>Get me</span>
              <input
                type="number"
                min={1}
                max={500}
                value={goalInput}
                onChange={(e) => setGoalInput(Math.max(1, Math.min(500, Number(e.target.value) || 1)))}
                className="input"
                style={{ width: 64, textAlign: "center" }}
              />
              <span style={{ fontSize: 13.5 }}>{ui.goalNoun}</span>
              <button
                type="button"
                className="btn btn-sm btn-primary grow-phone"
                style={{ marginLeft: "auto" }}
                onClick={() =>
                  run("startGoal", () =>
                    startAll({ orgSlug, instanceId, goalTarget: goalInput, runConfig: buildRunConfig() }),
                  )
                }
                disabled={pending}
              >
                {busy === "startGoal" ? "…" : "▶ Start all"}
              </button>
            </div>
            {dc != null ? (
              <TailorRun
                ui={ui}
                open={tailorOpen}
                onToggle={() => setTailorOpen((o) => !o)}
                nums={nums}
                setNum={setNum}
                bools={bools}
                setBool={setBool}
                lang={lang}
                setLang={setLang}
              />
            ) : null}
          </>
        )}
      </div>

      {/* Recurring scheduled run */}
      <ScheduleBlock
        orgSlug={orgSlug}
        instanceId={instanceId}
        saved={snapshot.schedule}
        goalNoun={ui.goalNoun}
        now={now}
        busy={busy}
        pending={pending}
        run={run}
      />

      {relationshipDms ? (
        <RelationshipDmsRow
          orgSlug={orgSlug}
          instanceId={instanceId}
          platform={relationshipDms.platform}
          enabled={relationshipDms.enabled}
          approvalsHref={relationshipDms.approvalsHref}
        />
      ) : null}

      {/* Funnel — one row per worker */}
      <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
        {snapshot.workers.map((w) => (
          <WorkerRow key={w.kind} w={w} now={now} active={active} showRun={active && sessionStarted}
            busy={busy} pending={pending}
            roleText={w.kind === "drafter" ? ui.drafterRole : ROLE[w.kind]}
            onToggle={(enabled) =>
              run(`toggle:${w.kind}`, () => setWorkerEnabled({ orgSlug, instanceId, worker: w.kind as "discovery" | "classifier" | "drafter" | "send" | "profiler" | "watchlist", enabled }))
            }
          />
        ))}
      </ul>

      {!active ? (
        <div style={{ marginTop: 10, fontSize: 12, color: "var(--ink-muted)" }}>
          {ui.pausedNote}
        </div>
      ) : null}
      {error ? (
        <div style={{ marginTop: 8, fontSize: 11.5, color: "var(--warn)" }}>{error}</div>
      ) : null}
    </section>
  );
}

function RelationshipDmsRow({
  orgSlug,
  instanceId,
  platform,
  enabled,
  approvalsHref,
}: {
  orgSlug: string;
  instanceId: string;
  platform: "linkedin" | "x";
  enabled: boolean;
  approvalsHref: string;
}) {
  const router = useRouter();
  const [checked, setChecked] = useState(enabled);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cap = RELATIONSHIP_DM_DAILY_CAPS[platform];

  useEffect(() => {
    setChecked(enabled);
  }, [enabled]);

  async function save(next: boolean) {
    setChecked(next);
    setSaving(true);
    setError(null);
    try {
      const res = await setRelationshipDmsEnabled({ orgSlug, instanceId, enabled: next });
      if (!res.ok) {
        setChecked(!next);
        setError(res.error.message);
        return;
      }
      router.refresh();
    } catch (err) {
      console.error("[relationship-dms] save failed:", err);
      setChecked(!next);
      setError("Could not save. Try again.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div
      style={{
        padding: 12,
        borderRadius: 10,
        background: "var(--paper-2)",
        boxShadow: "0 0 0 0.5px var(--rule-soft)",
        marginBottom: 14,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <span style={{ fontSize: 13.5, fontWeight: 600 }}>Friendly DMs</span>
            <span className="tag">{cap}/day</span>
          </div>
          <div style={{ fontSize: 11.5, color: "var(--ink-muted)", marginTop: 3, lineHeight: 1.35 }}>
            Independent from reply controls. Drafts from saved person context. Review required before anything is sent.
          </div>
        </div>
        <label
          style={{ display: "flex", alignItems: "center", gap: 8, cursor: saving ? "wait" : "pointer" }}
          title={checked ? "On — click to pause Friendly DMs" : "Off — click to enable Friendly DMs"}
        >
          <input
            type="checkbox"
            aria-label="Friendly DMs"
            checked={checked}
            disabled={saving}
            onChange={(e) => save(e.target.checked)}
          />
          <span className={`btn btn-sm ${checked ? "btn-primary" : ""}`}>
            {saving ? "Saving…" : checked ? "On" : "Off"}
          </span>
        </label>
      </div>
      <ReviewFriendlyDmsLink href={approvalsHref} />
      {error ? (
        <div role="alert" aria-live="polite" style={{ marginTop: 8, fontSize: 11.5, color: "var(--warn)" }}>
          {error}
        </div>
      ) : null}
    </div>
  );
}

// "Schedule" — a recurring scheduled run (0085). Arms a standing order that
// auto-fires Start all on a cadence (every N hours, or daily at HH:MM in a tz),
// so the pipeline runs without clicking the button. Saving with the toggle ON
// stamps the next fire time; OFF stores the settings but fires nothing. A firing
// does exactly what Start all does — this only sets the timer.
function ScheduleBlock({
  orgSlug,
  instanceId,
  saved,
  goalNoun,
  now,
  busy,
  pending,
  run,
}: {
  orgSlug: string;
  instanceId: string;
  saved: PipelineScheduleSnapshot | null;
  goalNoun: string;
  now: number | null;
  busy: string | null;
  pending: boolean;
  run: (key: string, fn: () => Promise<{ ok: boolean; error?: { message: string } }>) => void;
}) {
  const on = Boolean(saved?.enabled);
  const [open, setOpen] = useState(on);
  const [mode, setMode] = useState<"interval" | "daily">(saved?.mode ?? "daily");
  const [intervalHours, setIntervalHours] = useState(saved?.intervalHours ?? 6);
  const [dailyTime, setDailyTime] = useState(saved?.dailyTime ?? "09:00");
  const [goal, setGoal] = useState(saved?.goal ?? 20);
  // tz initialises to the saved value or "UTC" for a stable first render (no
  // hydration mismatch), then adopts the browser tz post-mount for a NEW schedule.
  const [tz, setTz] = useState(saved?.timezone ?? "UTC");
  useEffect(() => {
    if (!saved) {
      try {
        setTz(Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC");
      } catch {
        /* keep UTC */
      }
    }
  }, [saved]);

  function save(enabled: boolean) {
    const schedule = {
      enabled,
      mode,
      intervalHours:
        mode === "interval" ? Math.max(1, Math.min(168, Math.round(intervalHours || 6))) : null,
      dailyTime: mode === "daily" ? dailyTime : null,
      timezone: tz || "UTC",
      goal: Math.max(1, Math.min(500, Math.round(goal || 20))),
    };
    run("schedule", () => setRunSchedule({ orgSlug, instanceId, schedule }));
  }

  // "Next run" — local time, only after mount (now != null) so SSR and the first
  // client render match (toLocaleString is locale/tz-dependent → hydration unsafe).
  const nextLabel =
    on && saved?.nextAt && now != null
      ? new Date(saved.nextAt).toLocaleString(undefined, {
          weekday: "short",
          month: "short",
          day: "numeric",
          hour: "2-digit",
          minute: "2-digit",
        })
      : null;

  const cadenceSummary =
    saved?.mode === "interval"
      ? `every ${saved.intervalHours ?? "?"}h`
      : saved?.mode === "daily"
        ? `daily at ${saved.dailyTime ?? "?"}`
        : null;

  return (
    <div
      style={{
        padding: 12,
        borderRadius: 10,
        background: "var(--paper-2)",
        boxShadow: "0 0 0 0.5px var(--rule-soft)",
        marginBottom: 14,
      }}
    >
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="btn btn-xs btn-ghost"
        aria-expanded={open}
        style={{ fontFamily: "var(--mono)", fontSize: 11, display: "flex", alignItems: "center", gap: 8 }}
      >
        <span>{open ? "▾" : "▸"} Schedule</span>
        <span className="tag" style={{ color: on ? "var(--ok)" : "var(--ink-soft)" }}>
          <span className={on ? "dot dot-ok" : "dot dot-mute"} /> {on ? "on" : "off"}
        </span>
        {on && cadenceSummary ? (
          <span style={{ color: "var(--ink-soft)" }}>· {cadenceSummary}</span>
        ) : null}
      </button>

      {on && nextLabel ? (
        <div style={{ fontSize: 11.5, color: "var(--ink-muted)", marginTop: 6 }}>
          Next run: <span style={{ fontWeight: 500 }}>{nextLabel}</span> · then auto-pauses at {goal}.
        </div>
      ) : null}

      {open ? (
        <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 10 }}>
          {/* Mode selector */}
          <div style={{ display: "flex", gap: 6 }}>
            <button
              type="button"
              className={`btn btn-xs ${mode === "interval" ? "btn-primary" : ""}`}
              onClick={() => setMode("interval")}
            >
              Every N hours
            </button>
            <button
              type="button"
              className={`btn btn-xs ${mode === "daily" ? "btn-primary" : ""}`}
              onClick={() => setMode("daily")}
            >
              Daily at time
            </button>
          </div>

          {/* Cadence input */}
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", fontSize: 13 }}>
            {mode === "interval" ? (
              <>
                <span>Every</span>
                <input
                  type="number"
                  min={1}
                  max={168}
                  value={intervalHours}
                  onChange={(e) => setIntervalHours(Math.max(1, Math.min(168, Number(e.target.value) || 1)))}
                  className="input"
                  style={{ width: 64, textAlign: "center" }}
                />
                <span>hours</span>
              </>
            ) : (
              <>
                <span>Daily at</span>
                <input
                  type="time"
                  value={dailyTime}
                  onChange={(e) => setDailyTime(e.target.value)}
                  className="input"
                  style={{ width: 110 }}
                />
                <input
                  type="text"
                  value={tz}
