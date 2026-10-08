"use client";

import { useEffect, useState } from "react";

export type ErrorKind =
  | "404"
  | "500"
  | "403"
  | "offline"
  | "maintenance"
  | "agent-crashed";

type Severity = "ink" | "danger" | "warn" | "info" | "accent";

type ErrorAction = {
  label: string;
  href?: string;
  onClick?: () => void;
};

type ErrorSpec = {
  code: string;
  eyebrow: string;
  title: string;
  sub: string;
  detail: string[];
  art: ArtKind;
  severity: Severity;
};

const ERRORS: Record<ErrorKind, ErrorSpec> = {
  "404": {
    code: "404",
    eyebrow: "Not found · NLE-404",
    title: "This star isn't on the chart.",
    sub: "We followed the link but the page never assembled. It may have been moved, renamed, or it never existed in the first place.",
    detail: [
      "GET /workspace/draft/d-1183",
      "↳ resolver: drafts.find(id) → undefined",
      "↳ closest match: d-1138 · @swyx",
    ],
    art: "missing-star",
    severity: "ink",
  },
  "500": {
    code: "500",
    eyebrow: "Server error · NLE-500",
    title: "A wire came loose on our side.",
    sub: "Something in the workspace runtime threw an exception we weren't ready for. The team has been pinged automatically — no need to file anything.",
    detail: [
      "Error: TypeError · Cannot read property 'icp' of null",
      "  at DraftReview.composeAngles (drafter:412)",
      "  at WorkerPool.dispatch        (pool:88)",
    ],
    art: "loose-wire",
    severity: "danger",
  },
  "403": {
    code: "403",
    eyebrow: "Locked out · NLE-403",
    title: "This room is sealed for your role.",
    sub: "Your account is signed in and healthy — but this page lives behind a permission you don't currently hold. Ask your workspace admin to lift the latch.",
    detail: [
      "user.role: member",
      "required:  admin · operations.read",
      "scope:     workspace/current",
    ],
    art: "sealed",
    severity: "warn",
  },
  offline: {
    code: "OFF",
    eyebrow: "Connection lost · NLE-NET",
    title: "The signal went quiet.",
    sub: "We can't reach Noelle from here. Your agents keep running in the cloud — we just can't show you what they're up to until the line comes back.",
    detail: [
      "ws://app.trynoelle.com/live → closed (1006)",
      "last frame: 47s ago",
      "queue: 3 user actions held",
    ],
    art: "dropped-signal",
    severity: "info",
  },
  maintenance: {
    code: "MNT",
    eyebrow: "Scheduled maintenance · NLE-OFF",
    title: "Off-hours, on purpose.",
    sub: "We're upgrading the drafter and approvals workers. Reads still work; new agent runs are paused for the duration of the window.",
    detail: [
      "window: in progress · ~12m remaining",
      "affected: drafter, approvals, classifier",
      "reads:   unaffected",
    ],
    art: "moon",
    severity: "accent",
  },
  "agent-crashed": {
    code: "EXIT 137",
    eyebrow: "Worker fault · NLE-AGENT",
    title: "Drafter-4 fell asleep mid-run.",
    sub: "One of your X Intern workers crashed before the draft reached you. The remaining three are healthy and absorbed the queue.",
    detail: [
      "worker: drafter@4",
      "exit:   137 · SIGKILL (oom)",
      "task:   re-queued on @2",
    ],
    art: "dimmed-agent",
    severity: "danger",
  },
};

type Props = {
  kind: ErrorKind;
  primaryAction?: ErrorAction;
  secondaryAction?: ErrorAction;
  traceId?: string;
  /**
   * Render inside an existing app shell (e.g. a route-segment error boundary
   * that sits within the org nav layout) instead of taking over the viewport.
   * Drops the 100vh full-bleed background so the panel fits the content column.
   */
  embedded?: boolean;
};

export function ErrorScreen({
  kind,
  primaryAction,
  secondaryAction,
  traceId,
  embedded = false,
}: Props) {
  const e = ERRORS[kind] ?? ERRORS["404"];
  const tone = toneFor(e.severity);

  const [trace, setTrace] = useState<string | null>(null);
  useEffect(() => {
    setTrace(new Date().toISOString().slice(11, 19) + "Z");
  }, []);

  return (
    <div
      style={{
        minHeight: embedded ? "clamp(420px, 60vh, 640px)" : "100vh",
        background: embedded ? "transparent" : "var(--bg)",
        display: "grid",
        placeItems: "center",
        padding: 12,
        fontFamily: "var(--body, 'Inter', system-ui, sans-serif)",
        color: "var(--ink)",
      }}
    >
      <section
        style={{
          width: "100%",
          maxWidth: 1180,
          background: "var(--paper)",
          borderRadius: 14,
          boxShadow: "0 0 0 0.5px var(--rule), 0 12px 32px -16px rgba(31,26,18,.18)",
          overflow: "hidden",
          position: "relative",
          display: "grid",
          gridTemplateColumns: "minmax(0, 0.95fr) minmax(0, 1.05fr)",
          minHeight: 460,
        }}
        className="error-screen"
      >
        <ErrorArt kind={e.art} tone={tone} code={e.code} />

        <div
          style={{
            padding: "40px 44px 36px",
            display: "flex",
            flexDirection: "column",
            gap: 18,
            borderLeft: "1px solid var(--rule)",
            background: "var(--paper)",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
                fontFamily: "var(--mono, 'JetBrains Mono', ui-monospace, monospace)",
                fontSize: 10.5,
                letterSpacing: "0.14em",
                textTransform: "uppercase",
                color: tone,
              }}
            >
              <span
                style={{
                  width: 7,
                  height: 7,
                  borderRadius: "50%",
                  background: tone,
                  boxShadow: `0 0 0 3px color-mix(in oklch, ${tone} 22%, transparent)`,
                }}
              />
