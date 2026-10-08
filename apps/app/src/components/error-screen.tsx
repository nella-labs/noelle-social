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
              {e.eyebrow}
            </span>
            <span
              style={{
                marginLeft: "auto",
                fontFamily: "var(--mono, 'JetBrains Mono', ui-monospace, monospace)",
                fontSize: 11,
                color: "var(--ink-muted)",
              }}
              suppressHydrationWarning
            >
              trace · {trace ?? "··:··:··Z"}
            </span>
          </div>

          <h1
            className="serif"
            style={{
              margin: 0,
              fontSize: 44,
              lineHeight: 1.04,
              letterSpacing: "-0.015em",
              fontFamily: "var(--display, 'Instrument Serif', Georgia, serif)",
              fontWeight: 400,
              color: "var(--ink)",
            }}
          >
            {e.title}
          </h1>

          <p
            style={{
              margin: 0,
              fontSize: 15,
              lineHeight: 1.55,
              color: "var(--ink-2)",
              maxWidth: "44ch",
            }}
          >
            {e.sub}
          </p>

          <details
            style={{
              marginTop: 2,
              padding: "12px 14px",
              background: "var(--paper-2)",
              borderRadius: 10,
              boxShadow: "0 0 0 0.5px var(--rule)",
            }}
          >
            <summary
              style={{
                cursor: "pointer",
                listStyle: "none",
                display: "flex",
                alignItems: "center",
                gap: 8,
                fontFamily:
                  "var(--mono, 'JetBrains Mono', ui-monospace, monospace)",
                fontSize: 10.5,
                letterSpacing: "0.1em",
                textTransform: "uppercase",
                color: "var(--ink-muted)",
              }}
            >
              <span style={{ color: "var(--ink-soft)" }}>›</span>
              Technical detail
            </summary>
            <pre
              style={{
                margin: "10px 0 0",
                padding: 0,
                fontFamily:
                  "var(--mono, 'JetBrains Mono', ui-monospace, monospace)",
                fontSize: 11.5,
                lineHeight: 1.55,
                color: "var(--ink-2)",
                whiteSpace: "pre-wrap",
                wordBreak: "break-word",
              }}
            >
              {e.detail.join("\n")}
              {traceId ? `\ntrace-id: ${traceId}` : ""}
            </pre>
          </details>

          <div
            className="error-actions"
            style={{
              display: "flex",
              gap: 10,
              marginTop: 6,
              flexWrap: "wrap",
              alignItems: "center",
            }}
          >
            {primaryAction ? (
              <ActionButton variant="accent" action={primaryAction} />
            ) : null}
            {secondaryAction ? (
              <ActionButton variant="default" action={secondaryAction} />
            ) : null}
            {traceId ? (
              <button
                type="button"
                onClick={() => {
                  if (typeof navigator !== "undefined" && navigator.clipboard) {
                    void navigator.clipboard.writeText(traceId);
                  }
                }}
                style={{
                  marginLeft: "auto",
                  alignSelf: "center",
                  background: "transparent",
                  border: 0,
                  padding: 0,
                  fontFamily:
                    "var(--mono, 'JetBrains Mono', ui-monospace, monospace)",
                  fontSize: 11.5,
                  color: "var(--ink-muted)",
                  letterSpacing: "0.04em",
                  cursor: "pointer",
                }}
              >
                copy trace id ↗
              </button>
            ) : null}
          </div>
        </div>
      </section>

      <style>{`
        @media (max-width: 768px) {
          .error-screen { grid-template-columns: 1fr !important; min-height: 0 !important; }
          .error-screen > :first-child { min-height: 200px !important; }
          .error-screen > :nth-child(2) { border-left: 0 !important; border-top: 1px solid var(--rule); }
          .error-screen h1 { font-size: 34px !important; }
          .error-actions { flex-direction: column; align-items: stretch; }
          .error-actions > * { width: 100%; margin-left: 0; }
          .error-actions > a, .error-actions > button { height: 42px; }
        }
      `}</style>
    </div>
  );
}

function ActionButton({
  variant,
  action,
}: {
  variant: "accent" | "default";
  action: ErrorAction;
}) {
  const style: React.CSSProperties =
    variant === "accent"
      ? {
          background: "var(--accent)",
          color: "#fff",
          boxShadow:
            "0 0 0 0.5px var(--accent-deep), 0 6px 14px -8px color-mix(in oklch, var(--accent) 60%, transparent)",
        }
      : {
          background: "var(--paper-2)",
          color: "var(--ink)",
          boxShadow: "0 0 0 0.5px var(--rule)",
        };

  const base: React.CSSProperties = {
    display: "inline-flex",
    alignItems: "center",
    gap: 8,
    height: 36,
    padding: "0 16px",
    borderRadius: 10,
    border: 0,
    fontWeight: 500,
    fontSize: 13,
    fontFamily: "inherit",
    cursor: "pointer",
    ...style,
  };

  if (action.href) {
    return (
      <a href={action.href} style={{ ...base, textDecoration: "none" }}>
        {action.label}
      </a>
    );
  }
  return (
    <button type="button" onClick={action.onClick} style={base}>
      {action.label}
    </button>
  );
}

function toneFor(severity: Severity): string {
  switch (severity) {
    case "danger":
      return "var(--danger)";
    case "warn":
      return "var(--warn)";
    case "info":
      return "var(--info)";
    case "accent":
      return "var(--accent)";
    default:
      return "var(--ink)";
  }
}

// ─── Visual hero illustrations ──────────────────────────────────────────

type ArtKind =
  | "missing-star"
  | "loose-wire"
  | "sealed"
  | "dropped-signal"
  | "moon"
  | "dimmed-agent";

function ErrorArt({
  kind,
  tone,
  code,
}: {
  kind: ArtKind;
  tone: string;
  code: string;
}) {
  return (
    <div
      style={{
        position: "relative",
        overflow: "hidden",
        background: "color-mix(in oklch, var(--paper-2) 70%, var(--paper))",
        padding: "40px 32px",
        display: "grid",
        placeItems: "center",
        minHeight: 460,
      }}
    >
      <div
        aria-hidden
        style={{
          position: "absolute",
          inset: 0,
          pointerEvents: "none",
          backgroundImage: `
            radial-gradient(circle at 18% 22%, var(--ink) 0 1px, transparent 1.5px),
            radial-gradient(circle at 72% 14%, var(--ink) 0 1px, transparent 1.5px),
            radial-gradient(circle at 88% 58%, var(--ink) 0 1.2px, transparent 1.7px),
            radial-gradient(circle at 12% 78%, var(--ink) 0 1px, transparent 1.5px),
            radial-gradient(circle at 60% 86%, var(--ink) 0 1px, transparent 1.5px),
            radial-gradient(circle at 38% 44%, var(--ink) 0 0.8px, transparent 1.2px)
          `,
          opacity: 0.18,
        }}
      />

      <div
        style={{
          position: "relative",
          width: "min(360px, 80%)",
          aspectRatio: "1 / 1",
        }}
      >
        {kind === "missing-star" && <ArtMissingStar tone={tone} />}
        {kind === "loose-wire" && <ArtLooseWire tone={tone} />}
        {kind === "sealed" && <ArtSealed tone={tone} />}
        {kind === "dropped-signal" && <ArtDroppedSignal tone={tone} />}
        {kind === "moon" && <ArtMoon tone={tone} />}
        {kind === "dimmed-agent" && <ArtDimmedAgent tone={tone} />}
      </div>

      <div
        style={{
          position: "absolute",
          left: 24,
          bottom: 18,
          fontFamily: "var(--mono, 'JetBrains Mono', ui-monospace, monospace)",
          fontSize: 11,
          letterSpacing: "0.18em",
          textTransform: "uppercase",
          color: "var(--ink-soft)",
        }}
      >
        Error <span style={{ color: "var(--ink-2)" }}>{code}</span>
      </div>
      <div
        style={{
          position: "absolute",
          right: 24,
          bottom: 18,
          fontFamily: "var(--mono, 'JetBrains Mono', ui-monospace, monospace)",
          fontSize: 11,
          letterSpacing: "0.18em",
          textTransform: "uppercase",
          color: "var(--ink-soft)",
        }}
      >
        Noelle · workspace
      </div>
    </div>
  );
}

function ArtMissingStar({ tone }: { tone: string }) {
  const points: [number, number][] = [
    [80, 120],
    [150, 90],
    [220, 140],
    [270, 100],
    [250, 200],
    [180, 230],
    [110, 210],
  ];
  return (
    <svg viewBox="0 0 360 360" width="100%" height="100%">
      <g stroke="var(--rule)" strokeWidth="1" fill="none">
        <polyline points="80,120 150,90 220,140 270,100 250,200 180,230 110,210 80,120" />
      </g>
      {points.map(([x, y], i) => (
        <g key={i}>
          <circle cx={x} cy={y} r="6" fill="var(--paper)" stroke="var(--ink)" strokeWidth="1.2" />
          <circle cx={x} cy={y} r="1.6" fill="var(--ink)" />
        </g>
      ))}
      <circle cx="200" cy="170" r="14" fill="none" stroke={tone} strokeWidth="1.5" strokeDasharray="3 3" />
      <text x="200" y="174" textAnchor="middle" fontFamily="var(--mono)" fontSize="11" letterSpacing="0.06em" fill={tone}>
        404
      </text>
      <path d="M 200 170 Q 280 240 320 310" stroke={tone} strokeWidth="1" strokeDasharray="2 4" fill="none" opacity="0.7" />
      <g transform="translate(320 310)">
        <circle r="7" fill={tone} />
        <circle r="14" fill="none" stroke={tone} strokeWidth="1" opacity="0.4" />
      </g>
    </svg>
  );
}

function ArtLooseWire({ tone }: { tone: string }) {
  return (
    <svg viewBox="0 0 360 360" width="100%" height="100%">
      <g>
        <circle cx="80" cy="180" r="22" fill="var(--paper)" stroke="var(--ink)" strokeWidth="1.5" />
        <circle cx="80" cy="180" r="6" fill="var(--ink)" />
        <text x="80" y="232" textAnchor="middle" fontFamily="var(--mono)" fontSize="10" letterSpacing="0.1em" fill="var(--ink-muted)">
          CLIENT
        </text>
        <circle cx="280" cy="180" r="22" fill="var(--paper)" stroke="var(--ink)" strokeWidth="1.5" />
        <circle cx="280" cy="180" r="6" fill="var(--ink)" />
        <text x="280" y="232" textAnchor="middle" fontFamily="var(--mono)" fontSize="10" letterSpacing="0.1em" fill="var(--ink-muted)">
          SERVER
        </text>
      </g>
      <path d="M 100 180 C 140 150, 160 160, 178 178" stroke={tone} strokeWidth="2.5" fill="none" />
      <g stroke={tone} strokeWidth="1.6" fill="none" opacity="0.85">
        <path d="M 178 178 L 188 168" />
        <path d="M 178 178 L 192 182" />
        <path d="M 178 178 L 184 192" />
      </g>
      <path d="M 200 184 C 220 200, 240 200, 258 180" stroke={tone} strokeWidth="1.2" strokeDasharray="3 4" fill="none" opacity="0.45" />
      <circle cx="178" cy="178" r="14" fill={tone} opacity="0.18" />
      <circle cx="178" cy="178" r="4" fill={tone} />
    </svg>
  );
}

function ArtSealed({ tone }: { tone: string }) {
  return (
    <svg viewBox="0 0 360 360" width="100%" height="100%">
      <rect x="80" y="100" width="200" height="140" rx="6" fill="var(--paper)" stroke="var(--ink)" strokeWidth="1.5" />
      <path d="M 80 110 L 180 180 L 280 110" stroke="var(--ink)" strokeWidth="1.2" fill="none" />
      <circle cx="180" cy="200" r="32" fill={tone} opacity="0.18" />
      <circle cx="180" cy="200" r="22" fill={tone} />
      <circle cx="180" cy="195" r="4" fill="var(--paper)" />
      <rect x="178" y="195" width="4" height="9" fill="var(--paper)" />
      <g transform="rotate(-6 180 90)">
        <rect x="100" y="80" width="160" height="20" fill="var(--ink)" />
        <text x="180" y="94" textAnchor="middle" fontFamily="var(--mono)" fontSize="11" letterSpacing="0.4em" fill="var(--paper)">
          PRIVATE
        </text>
      </g>
    </svg>
  );
}

function ArtDroppedSignal({ tone }: { tone: string }) {
  return (
    <svg viewBox="0 0 360 360" width="100%" height="100%">
      <g transform="translate(90 220)">
        <path d="M 0 0 L -22 -110 L 22 -110 Z" fill="var(--paper)" stroke="var(--ink)" strokeWidth="1.2" />
        <line x1="-14" y1="-30" x2="14" y2="-30" stroke="var(--ink)" strokeWidth="1" />
        <line x1="-18" y1="-60" x2="18" y2="-60" stroke="var(--ink)" strokeWidth="1" />
        <line x1="-22" y1="-90" x2="22" y2="-90" stroke="var(--ink)" strokeWidth="1" />
        <circle cx="0" cy="-110" r="5" fill={tone} />
      </g>
      <path d="M 130 200 Q 145 160, 160 200 T 190 200 T 220 200" stroke={tone} strokeWidth="2.5" fill="none" />
