"use client";

import { useEffect, useState } from "react";
import { loadVideoClipDetail } from "@/app/app/[orgSlug]/agents/[instanceId]/video-watchlist-actions";
import type { VideoClipDetail } from "@/lib/video-queries";
import { reachMultiple, reachTone } from "@/lib/video-metrics";
import type { VideoClipRow } from "@/lib/video-queries";
import { fmtCount, ReachBadge, REACH_TONE_COLOR } from "./video-reach";

// The Discover clip popup — plays the actual reel (platform embed iframe, since
// the stored video_url expires + IG/TikTok block hotlinking) next to Nova's
// teardown: hook, why-it-worked, beat timeline, transitions, on-screen text,
// pacing, CTA, sound, transcript. Teardown is lazy-loaded on open so the grid
// payload stays light. Defensive reads — a clip may have no teardown yet ({}).

/** Build the platform embed src from the canonical URL (+ external_id fallback). */
function embedSrc(platform: string, url: string, externalId: string): string | null {
  if (platform === "instagram") {
    const m = url.match(/instagram\.com\/(?:reel|reels|p|tv)\/([A-Za-z0-9_-]+)/);
    const code = m?.[1];
    return code ? `https://www.instagram.com/reel/${code}/embed` : null;
  }
  if (platform === "tiktok") {
    const m = url.match(/\/video\/(\d+)/);
    const id = m?.[1] ?? (/^\d+$/.test(externalId) ? externalId : null);
    return id ? `https://www.tiktok.com/embed/v2/${id}` : null;
  }
  return null;
}

type Rec = Record<string, unknown>;
const asRec = (v: unknown): Rec => (v && typeof v === "object" ? (v as Rec) : {});
const asArr = (v: unknown): Rec[] => (Array.isArray(v) ? v.map(asRec) : []);
const str = (v: unknown): string => (typeof v === "string" ? v : "");
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

const MONO: React.CSSProperties = { fontFamily: "var(--mono)", fontSize: 10, letterSpacing: "0.06em", color: "var(--ink-soft)", textTransform: "uppercase" };

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ marginTop: 16 }}>
      <div style={MONO}>{label}</div>
      <div style={{ marginTop: 6 }}>{children}</div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div style={{ fontFamily: "var(--mono)", fontSize: 13, color: "var(--ink)" }}>{value}</div>
      <div style={{ ...MONO, fontSize: 9 }}>{label}</div>
    </div>
  );
}

function Teardown({ teardown, transcript }: { teardown: unknown; transcript: string | null }) {
  const t = asRec(teardown);
  const hook = asRec(t.hook);
  const beats = asArr(t.beats);
  const transitions = asArr(t.transitions);
  const onscreen = asArr(t.onscreen);
  const pacing = asRec(t.pacing);
  const cta = asRec(t.cta);
  const sound = asRec(t.sound);
  const why = str(t.whyItWorked);
  const hasAny = str(hook.text) || why || beats.length || transitions.length || onscreen.length;

  if (!hasAny) {
    return (
      <p style={{ fontSize: 13, color: "var(--ink-muted)", lineHeight: 1.5 }}>
        Nova hasn’t torn this clip down yet. Deep-tier clips (flagged{" "}
        <span style={{ fontFamily: "var(--mono)", fontSize: 11 }}>deep</span>) get a full breakdown on the next analysis pass.
      </p>
    );
  }

  return (
    <div>
      {str(hook.text) ? (
        <Section label={`Hook · ${str(hook.type) || "open"}`}>
          <p style={{ fontSize: 15, color: "var(--ink)", fontFamily: "var(--serif)", lineHeight: 1.35 }}>“{str(hook.text)}”</p>
          {str(hook.reason) ? (
            <p style={{ fontSize: 12.5, color: "var(--ink-muted)", marginTop: 4, lineHeight: 1.45 }}>{str(hook.reason)}</p>
          ) : null}
        </Section>
      ) : null}

      {why ? (
        <Section label="Why it worked">
          <p style={{ fontSize: 13.5, color: "var(--ink)", lineHeight: 1.5 }}>{why}</p>
        </Section>
      ) : null}

      {beats.length ? (
        <Section label="Beat structure">
          <ol style={{ listStyle: "none", padding: 0, margin: 0, display: "flex", flexDirection: "column", gap: 8 }}>
            {beats.map((b, i) => (
              <li key={i} style={{ display: "flex", gap: 10, alignItems: "baseline" }}>
                <span style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--ink-soft)", minWidth: 58 }}>
                  {num(b.tStart) ?? 0}s–{num(b.tEnd) ?? 0}s
                </span>
                <span style={{ fontSize: 13, color: "var(--ink)" }}>
                  <strong style={{ fontWeight: 600 }}>{str(b.purpose) || "beat"}</strong>
                  {str(b.text) ? <span style={{ color: "var(--ink-muted)" }}> — {str(b.text)}</span> : null}
                </span>
              </li>
            ))}
          </ol>
        </Section>
      ) : null}

      {onscreen.length ? (
        <Section label="On-screen text">
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
            {onscreen.map((o, i) => (
              <span key={i} className="tag" style={{ height: "auto", padding: "3px 8px", fontSize: 11 }}>
                {num(o.t) != null ? `${num(o.t)}s · ` : ""}
                {str(o.text) || str(o.kind) || "text"}
              </span>
            ))}
          </div>
        </Section>
      ) : null}

      {transitions.length ? (
        <Section label="Transitions">
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
            {transitions.map((tr, i) => (
              <span key={i} className="tag" style={{ height: 20, fontSize: 11 }}>
                {num(tr.t) != null ? `${num(tr.t)}s ` : ""}
                {str(tr.type) || "cut"}
              </span>
            ))}
          </div>
        </Section>
      ) : null}

      {num(pacing.cutsPerSec) != null || num(pacing.wordsPerSec) != null ? (
        <Section label="Pacing">
          <div style={{ display: "flex", gap: 22 }}>
            {num(pacing.cutsPerSec) != null ? <Stat label="cuts / sec" value={String(num(pacing.cutsPerSec))} /> : null}
            {num(pacing.avgBeatSec) != null ? <Stat label="avg beat" value={`${num(pacing.avgBeatSec)}s`} /> : null}
            {num(pacing.wordsPerSec) != null ? <Stat label="words / sec" value={String(num(pacing.wordsPerSec))} /> : null}
          </div>
        </Section>
      ) : null}

      {cta.present ? (
        <Section label="Call to action">
          <p style={{ fontSize: 13, color: "var(--ink)" }}>
            {str(cta.text) || "Present"}
            {str(cta.placement) && str(cta.placement) !== "none" ? (
              <span style={{ color: "var(--ink-soft)" }}> · {str(cta.placement)}</span>
            ) : null}
          </p>
        </Section>
      ) : null}

      {str(sound.trackName) || sound.trending ? (
        <Section label="Sound">
          <p style={{ fontSize: 13, color: "var(--ink)" }}>
            {str(sound.trackName) || "—"}
            {sound.trending ? <span style={{ color: "var(--rust, #b4541f)" }}> · trending</span> : null}
            {sound.beatSynced ? <span style={{ color: "var(--ink-soft)" }}> · beat-synced</span> : null}
          </p>
        </Section>
      ) : null}

      {transcript ? (
        <Section label="Transcript">
          <pre
            style={{
              fontFamily: "var(--mono)",
              fontSize: 11,
              color: "var(--ink-muted)",
              whiteSpace: "pre-wrap",
              lineHeight: 1.55,
              maxHeight: 220,
              overflowY: "auto",
              margin: 0,
              padding: "10px 12px",
              background: "var(--paper-2, rgba(0,0,0,0.03))",
              borderRadius: 8,
            }}
          >
            {transcript}
          </pre>
        </Section>
      ) : null}
    </div>
  );
}

export function ClipDetailModal({
  clip,
  orgSlug,
  instanceId,
  onClose,
}: {
  clip: VideoClipRow;
  orgSlug: string;
  instanceId: string;
  onClose: () => void;
}) {
  const [detail, setDetail] = useState<VideoClipDetail | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  useEffect(() => {
    let live = true;
    setLoading(true);
    loadVideoClipDetail({ orgSlug, instanceId, clipId: clip.id })
      .then((r) => {
        if (live && r.ok) setDetail(r.clip);
      })
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [clip.id, orgSlug, instanceId]);

  const rm = reachMultiple(clip.views, clip.author_follower_count);
  const embed = embedSrc(clip.platform, clip.url, clip.external_id);

  return (
    <div
      role="dialog"
      aria-modal="true"
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 100,
        background: "rgba(20,16,8,0.55)",
        backdropFilter: "blur(2px)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 20,
      }}
    >
      <div
        className="card clay-flat"
        onClick={(e) => e.stopPropagation()}
        style={{
          width: "min(920px, 100%)",
          maxHeight: "90vh",
          padding: 0,
          overflow: "hidden",
          display: "grid",
          gridTemplateColumns: "minmax(0, 320px) 1fr",
        }}
      >
        {/* Left: the reel itself (9:16 embed), or thumbnail fallback. */}
        <div style={{ background: "#0d0a06", position: "relative", minHeight: 420 }}>
          {embed ? (
            <iframe
              title={`@${clip.author_handle} reel`}
              src={embed}
              allow="autoplay; encrypted-media; clipboard-write"
              allowFullScreen
              style={{ width: "100%", height: "100%", minHeight: 420, border: 0, display: "block" }}
            />
          ) : clip.thumb_url ? (
            // Raw <img>: clip.thumb_url is an arbitrary remote host, not a configured
                // next/image remotePattern.
            <img src={clip.thumb_url} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
          ) : null}
          <a
            href={clip.url}
            target="_blank"
            rel="noreferrer"
            className="btn btn-sm"
            style={{ position: "absolute", bottom: 10, left: 10, opacity: 0.92 }}
          >
            Open on {clip.platform === "tiktok" ? "TikTok" : "Instagram"} ↗
          </a>
        </div>

        {/* Right: header, stats, teardown. Scrolls independently. */}
        <div style={{ padding: "18px 20px", overflowY: "auto", maxHeight: "90vh" }}>
          <div style={{ display: "flex", alignItems: "flex-start", gap: 10 }}>
            <div style={{ flex: 1 }}>
              <div style={{ fontFamily: "var(--mono)", fontSize: 12, color: "var(--ink)" }}>@{clip.author_handle}</div>
              {clip.caption ? (
                <p style={{ fontSize: 13, color: "var(--ink-muted)", marginTop: 5, lineHeight: 1.45 }}>{clip.caption}</p>
              ) : null}
            </div>
            <button type="button" className="btn btn-sm" onClick={onClose} aria-label="Close" style={{ flexShrink: 0 }}>
              ✕
            </button>
          </div>

          <div
            style={{
              display: "flex",
              gap: 22,
              alignItems: "center",
              marginTop: 14,
              paddingBottom: 14,
              borderBottom: "0.5px solid var(--rule)",
            }}
          >
            <Stat label="views" value={fmtCount(clip.views)} />
            <Stat label="likes" value={fmtCount(clip.likes)} />
            <Stat label="comments" value={fmtCount(clip.comments)} />
            <div style={{ marginLeft: "auto" }}>
              <ReachBadge multiple={rm} views={clip.views} followers={clip.author_follower_count} size="sm" />
              {rm != null ? (
                <div style={{ ...MONO, fontSize: 9, marginTop: 2, color: REACH_TONE_COLOR[reachTone(rm)] }}>
                  {rm >= 1 ? "views ≥ followers" : "views < followers"}
                </div>
              ) : null}
            </div>
          </div>

          {loading ? (
            <p style={{ fontSize: 13, color: "var(--ink-soft)", marginTop: 18 }}>Loading teardown…</p>
          ) : (
            <Teardown teardown={detail?.teardown} transcript={detail?.transcript ?? null} />
          )}
        </div>
      </div>
    </div>
  );
}
