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
