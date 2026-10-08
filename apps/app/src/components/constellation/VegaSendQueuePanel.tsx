"use client";

import { useEffect, useState } from "react";
import type {
  AutoSendQueueRow,
  AutoSendUsage,
  SentApprovalRow,
} from "@/lib/queries";
import { useMounted } from "@/lib/use-mounted";
import {
  quietHoldEndMs,
  fmtQuietClock,
  QUIET_START_HOUR_UTC,
  QUIET_END_HOUR_UTC,
} from "@/lib/quiet-window";
import {
  deriveAutopilotStatus,
  nextSendTargetAt,
  type AutopilotTone,
} from "./autopilot-status";

/**
 * Three distinct ways a reply reached X, kept legible so "manual" is never
 * ambiguous: a worker auto-post, a dashboard Send (posted via your token, has a
 * link), or a by-hand post on X that you marked sent (no link unless pasted).
 */
const SEND_METHOD: Record<
  SentApprovalRow["sendMethod"],
  { label: string; title: string }
> = {
  auto: { label: "auto", title: "Auto-sent by the send worker" },
  dashboard: { label: "dashboard", title: "You clicked Send in the dashboard — Noelle posted it via your X token" },
  manual_x: { label: "on X · you", title: "You posted this on X yourself, then marked it sent" },
};

/**
 * "What's in flight + what just shipped" panel for Vega's agent page.
 *
 * Replaces the prior model where the founder had to take auto-send on
 * faith — there was no visible queue and no list of what actually went
 * out. The queue half ticks live (re-renders every second so the
 * countdown stays honest); the sent half is server-rendered and reflects
 * `noelle.approvals` rows with status='sent'.
 */
export function VegaSendQueuePanel({
  queue,
  sent,
  autoSendEnabled,
  configHref,
  replySendEnabled,
  usage,
}: {
  queue: AutoSendQueueRow[];
  sent: SentApprovalRow[];
  autoSendEnabled: boolean;
  configHref: string;
  /**
   * Master send switch (reply_send_enabled). OPTIONAL: only supplied when the
   * NOELLE_AUTOPILOT_PANEL flag is on. When undefined, the panel renders
   * byte-identical to before (single auto-send tag, no autopilot banner).
   */
  replySendEnabled?: boolean;
  /**
   * Recent auto-send usage vs. the labelled default ceiling. OPTIONAL and may
   * be null: the query fails closed, so null HIDES the caps row rather than
   * fabricating "0 of N" headroom.
   */
  usage?: AutoSendUsage | null;
}) {
  // The autopilot banner is opt-in behind the server flag: it's shown iff the
  // master-switch prop was threaded through (flag on). This keeps the flag-OFF
  // markup identical to today.
  const showAutopilot = replySendEnabled !== undefined;
  return (
    <section className="card">
      <div className="card-h">
        <h3>Send queue</h3>
        <span className="tag">
          {autoSendEnabled ? (
            <>
              <span className="dot dot-ok" /> auto-send on
            </>
          ) : (
            <>auto-send off</>
          )}
        </span>
      </div>
      {showAutopilot ? (
        <AutopilotBanner
          replySendEnabled={replySendEnabled}
          autoSendEnabled={autoSendEnabled}
          queue={queue}
          usage={usage ?? null}
        />
      ) : null}
      <div
        style={{
          fontSize: 12.5,
          color: "var(--ink-muted)",
          marginBottom: 12,
          lineHeight: 1.45,
        }}
      >
        {autoSendEnabled
          ? "Approvals the drafter scheduled for auto-send. The send worker pulls the next due row each tick and posts through your X token."
          : "Auto-send is off, so nothing queues here. Approvals land in the inbox for human review instead."}{" "}
        <a href={configHref} style={{ color: "var(--accent)" }}>
          configure →
        </a>
      </div>
      <QueueList rows={queue} />

      <hr className="rule-soft" style={{ margin: "18px 0 14px" }} />

      <RecentlySent rows={sent} />
    </section>
  );
}

/** Semantic autopilot tone → Constellation token + tag class. */
const TONE_STYLE: Record<AutopilotTone, { color: string; tag: string; dot: string }> = {
  muted: { color: "var(--ink-muted)", tag: "tag", dot: "" },
  ok: { color: "var(--ok)", tag: "tag tag-ok", dot: "dot-ok" },
  warn: { color: "var(--warn)", tag: "tag tag-warn", dot: "dot-warn" },
  accent: { color: "var(--accent)", tag: "tag", dot: "" },
};

/**
 * Honest autopilot status header (NOELLE_AUTOPILOT_PANEL). Collapses the two
 * master switches into one legible state, shows the next stamped send (quiet-
 * aware, so an overnight hold reads as a hold not a stall), and — when the
 * fail-closed usage query returned a value — the recent auto-send velocity vs.
 * the labelled default ceiling. Reflect-only: it arms and sends nothing.
 */
function AutopilotBanner({
  replySendEnabled,
  autoSendEnabled,
  queue,
  usage,
}: {
  replySendEnabled: boolean;
  autoSendEnabled: boolean;
  queue: AutoSendQueueRow[];
  usage: AutoSendUsage | null;
}) {
  const status = deriveAutopilotStatus({ replySendEnabled, autoSendEnabled });
  const tone = TONE_STYLE[status.tone];
  const nextIso = nextSendTargetAt(queue);
  return (
    <div
      role="status"
      aria-label={`Autopilot status: ${status.label}. ${status.description}`}
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 8,
        padding: "12px 14px",
        marginBottom: 12,
        borderRadius: 12,
        border: "1px solid var(--rule)",
        background: "var(--paper-deep)",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <span className={tone.tag} style={{ fontSize: 11, color: tone.color }}>
          {tone.dot ? <span className={`dot ${tone.dot}`} /> : null}
          {status.label}
        </span>
        {nextIso ? <NextSendReadout targetAt={nextIso} /> : null}
      </div>
      <div style={{ fontSize: 12, color: "var(--ink-muted)", lineHeight: 1.45 }}>
        {status.description}
      </div>
      {usage ? (
        <div
          style={{
            display: "flex",
            gap: 16,
            flexWrap: "wrap",
            fontFamily: "var(--mono)",
            fontSize: 11,
            color: "var(--ink-soft)",
          }}
        >
          <span title="Auto-sends completed in the last 30 minutes vs. the default velocity ceiling (the worker enforces the real limit).">
            30 min: {usage.per30Min} of {usage.per30MinCap}{" "}
            <span style={{ color: "var(--ink-soft)" }}>· default ceiling</span>
          </span>
          <span title="Auto-sends completed in the last 24 hours vs. the default daily ceiling (the worker enforces the real limit).">
            24 h: {usage.perDay} of {usage.perDayCap}{" "}
            <span style={{ color: "var(--ink-soft)" }}>· default ceiling</span>
          </span>
        </div>
      ) : null}
    </div>
  );
}

/**
 * Next stamped send time, quiet-aware. Mount-guarded (renders a stable
