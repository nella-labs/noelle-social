"use client";

import type { RemotionAssetSpec } from "@noelle/contracts";
import { AbsoluteFill, interpolate, Sequence, spring, useCurrentFrame, useVideoConfig } from "remotion";

// Nova's Remotion overlay compositions — vertical 1080×1920 (9:16), Constellation
// palette (cream + rust). Each renders one RemotionAssetSpec kind. Pure remotion
// (useCurrentFrame/interpolate/spring) so the same component previews in
// @remotion/player and would render headless via @remotion/renderer later.

export const VIDEO_W = 1080;
export const VIDEO_H = 1920;
export const VIDEO_FPS = 30;

const CREAM = "#F4EDE2";
const INK = "#241B12";
const RUST = "#B4471E";
const RULE = "rgba(36,27,18,0.14)";

const font =
  '"Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif';

function Frame({ children }: { children: React.ReactNode }) {
  return (
    <AbsoluteFill style={{ backgroundColor: CREAM, fontFamily: font, color: INK }}>{children}</AbsoluteFill>
  );
}

function Title({ children }: { children: React.ReactNode }) {
  const frame = useCurrentFrame();
  const o = interpolate(frame, [0, 14], [0, 1], { extrapolateRight: "clamp" });
  const y = interpolate(frame, [0, 14], [24, 0], { extrapolateRight: "clamp" });
  return (
    <div
      style={{
        position: "absolute",
        top: 120,
        left: 90,
        right: 90,
        fontSize: 76,
        fontWeight: 600,
        lineHeight: 1.08,
        letterSpacing: "-0.02em",
        opacity: o,
        transform: `translateY(${y}px)`,
      }}
    >
      {children}
    </div>
  );
}

function BarChart({ spec, accent }: { spec: Extract<RemotionAssetSpec, { kind: "bar_chart" }>; accent: string }) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const max = Math.max(...spec.points.map((p) => Math.abs(p.value)), 1);
  const areaTop = spec.title ? 380 : 200;
  const areaH = 1180;
  const gap = 36;
  const barW = (VIDEO_W - 180 - gap * (spec.points.length - 1)) / spec.points.length;
  return (
    <Frame>
      {spec.title ? <Title>{spec.title}</Title> : null}
      <div style={{ position: "absolute", left: 90, right: 90, top: areaTop, height: areaH }}>
        {spec.points.map((p, i) => {
          const grow = spring({ frame: frame - i * 4, fps, config: { damping: 18, mass: 0.7 } });
          const h = (Math.abs(p.value) / max) * (areaH - 120) * grow;
          const x = i * (barW + gap);
          return (
            <div key={i} style={{ position: "absolute", left: x, bottom: 96, width: barW, textAlign: "center" }}>
              <div style={{ fontSize: 40, fontWeight: 700, marginBottom: 14, opacity: grow }}>
                {Math.round(p.value * grow).toLocaleString()}
              </div>
              <div style={{ width: "100%", height: h, background: accent, borderRadius: 14 }} />
              <div style={{ fontSize: 30, marginTop: 18, color: INK, opacity: 0.7 }}>{p.label}</div>
            </div>
          );
        })}
        <div style={{ position: "absolute", left: 0, right: 0, bottom: 90, height: 2, background: RULE }} />
      </div>
    </Frame>
  );
}

function LineChart({ spec, accent }: { spec: Extract<RemotionAssetSpec, { kind: "line_chart" }>; accent: string }) {
  const frame = useCurrentFrame();
  const ys = spec.series.map((s) => s.y);
  const min = Math.min(...ys);
  const max = Math.max(...ys);
  const span = max - min || 1;
  const areaTop = spec.title ? 420 : 240;
  const areaH = 1080;
  const w = VIDEO_W - 180;
  const pts = spec.series.map((s, i) => {
    const x = 90 + (i / (spec.series.length - 1)) * w;
    const y = areaTop + (1 - (s.y - min) / span) * areaH;
    return { x, y, label: String(s.x) };
  });
  const reveal = interpolate(frame, [0, spec.durationFrames * 0.7], [0, 1], { extrapolateRight: "clamp" });
  const shown = Math.max(2, Math.ceil(pts.length * reveal));
  const d = pts.slice(0, shown).map((p, i) => `${i === 0 ? "M" : "L"} ${p.x} ${p.y}`).join(" ");
  const head = pts[shown - 1];
  return (
    <Frame>
      {spec.title ? <Title>{spec.title}</Title> : null}
      <svg width={VIDEO_W} height={VIDEO_H} style={{ position: "absolute", inset: 0 }}>
        <line x1={90} y1={areaTop + areaH} x2={VIDEO_W - 90} y2={areaTop + areaH} stroke={RULE} strokeWidth={2} />
        <path d={d} fill="none" stroke={accent} strokeWidth={10} strokeLinecap="round" strokeLinejoin="round" />
        {head ? <circle cx={head.x} cy={head.y} r={18} fill={accent} /> : null}
      </svg>
      {head ? (
        <div style={{ position: "absolute", left: Math.min(head.x, VIDEO_W - 320), top: head.y - 120, fontSize: 48, fontWeight: 700, color: accent }}>
          {pts[shown - 1] ? Math.round(spec.series[shown - 1].y).toLocaleString() : ""}
        </div>
      ) : null}
    </Frame>
  );
}

function KineticCaption({ spec, accent }: { spec: Extract<RemotionAssetSpec, { kind: "kinetic_caption" }>; accent: string }) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  return (
    <Frame>
      <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", justifyContent: "center", padding: "0 110px", gap: 28 }}>
        {spec.lines.map((line, i) => {
          const s = spring({ frame: frame - i * 10, fps, config: { damping: 16 } });
          return (
            <div
              key={i}
              style={{
                fontSize: 82,
                fontWeight: 800,
                lineHeight: 1.05,
                letterSpacing: "-0.02em",
                color: i % 2 === 1 ? accent : INK,
                opacity: s,
                transform: `translateY(${(1 - s) * 40}px) scale(${0.92 + s * 0.08})`,
              }}
            >
              {line}
            </div>
          );
        })}
      </div>
    </Frame>
  );
}

function LowerThird({ spec, accent }: { spec: Extract<RemotionAssetSpec, { kind: "lower_third" }>; accent: string }) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const s = spring({ frame, fps, config: { damping: 18 } });
  const x = interpolate(s, [0, 1], [-VIDEO_W, 0]);
  return (
    <AbsoluteFill style={{ fontFamily: font, justifyContent: "flex-end" }}>
      <div style={{ transform: `translateX(${x}px)`, margin: "0 0 320px 90px", maxWidth: 880 }}>
        <div style={{ display: "inline-block", background: accent, color: "#FFF", fontSize: 64, fontWeight: 700, padding: "18px 34px", borderRadius: 16 }}>
          {spec.title}
        </div>
        {spec.subtitle ? (
          <div style={{ marginTop: 18, background: INK, color: CREAM, fontSize: 40, padding: "14px 28px", borderRadius: 12, display: "inline-block" }}>
            {spec.subtitle}
          </div>
        ) : null}
      </div>
    </AbsoluteFill>
  );
}

/**
 * The draft's whole visual track, sequenced — the live-preview "reel". Plays each
 * overlay back to back (hook caption first if given), so the right pane previews
 * the actual video, not just one graphic. Falls back to the hook alone.
 */
export function DraftReel({ specs, hook }: { specs: RemotionAssetSpec[]; hook?: string }) {
  const clips: RemotionAssetSpec[] = [];
  if (hook && hook.trim()) {
    clips.push({ kind: "kinetic_caption", lines: hook.trim().split(/\r?\n/).filter(Boolean).slice(0, 3), durationFrames: 90 });
  }
  clips.push(...specs);
  if (clips.length === 0) return <Frame>{null}</Frame>;
  let offset = 0;
  return (
    <AbsoluteFill style={{ backgroundColor: CREAM }}>
      {clips.map((spec, i) => {
        const from = offset;
        offset += spec.durationFrames;
        return (
          <Sequence key={i} from={from} durationInFrames={spec.durationFrames}>
            <VisualComposition spec={spec} />
          </Sequence>
        );
      })}
    </AbsoluteFill>
  );
}

/** Total frames a DraftReel runs for (hook caption + each visual). */
export function draftReelDuration(specs: RemotionAssetSpec[], hook?: string): number {
