"use client";

import { useEffect, useMemo, useState, useTransition, type CSSProperties, type Dispatch, type SetStateAction } from "react";
import { remotionAssetFromGraphSpec, type RemotionAssetSpec, type ScriptEditProposal } from "@noelle/contracts";
import { Avatar } from "@/components/constellation/Avatar";
import type { VideoDraftRow, VideoIdeaRow, InspirationClip } from "@/lib/video-studio-queries";
import type { VerifierTrace } from "@/lib/posts-queries";
import type { VideoClipRow } from "@/lib/video-queries";
import {
  markVideoDraftReady,
  dismissStudioItem,
  saveVideoDraftScript,
  saveVideoDraftStructure,
} from "@/app/app/[orgSlug]/studio/actions";
import { StudioStillGenerator } from "@/app/app/[orgSlug]/studio/StudioStillGenerator";
import { AgentChat } from "@/components/agent-panels/AgentChat";
import { ReelPreview } from "./remotion/VisualPreview";
import { VisualCard, graphSpecSeconds, footageCues, type LooseSpec } from "./DraftVisualsPanel";
import { InspirationStrip } from "./InspirationStrip";
import { ClipDetailModal } from "./ClipDetailModal";
import { Field, VerifierTraceCard } from "./drafts-studio-chrome";
import { useStudioColumns, useDraftSelection, StudioListPane } from "./drafts-studio-shell";
import {
  buildPlainTextScript,
  buildMarkdownScript,
  scriptFilenameSlug,
  downloadTextFile,
  type ScriptExportInput,
} from "./video-script-export";

const NOVA_ACCENT = "oklch(0.58 0.13 305)";

type StatusKey = "draft" | "ready" | "published" | "dismissed";
const STATUS_META: Record<string, { label: string; color: string }> = {
  draft: { label: "Draft", color: "var(--ink-muted)" },
  ready: { label: "Ready", color: "var(--ok)" },
  published: { label: "Posted", color: "var(--accent)" },
};

const num = (v: unknown): number => (typeof v === "number" ? v : Number(v) || 0);

type DraftBuffer = {
  identity: string;
  selection: object;
  beats: Array<Record<string, unknown>>;
  beatLines: string[];
  script: string;
  linesDirty: boolean;
  scriptDirty: boolean;
};

function draftBuffer(identity: string, draft: VideoDraftRow): DraftBuffer {
  const beats = Array.isArray(draft.structure) ? (draft.structure as Array<Record<string, unknown>>) : [];
  return {
    identity, selection: {}, beats,
    beatLines: beats.map((beat) => String(beat.line ?? "")),
    script: draft.final_script ?? draft.script ?? "",
    linesDirty: false, scriptDirty: false,
  };
}

/** Short label for an on-screen visual spec (chart title / kind). */
const specLabel = (raw: LooseSpec): string => {
  const r = raw as Record<string, unknown>;
  const title = typeof r.title === "string" ? r.title.trim() : "";
  const kind = typeof r.kind === "string" ? r.kind.trim() : "";
  if (title && kind) return `${title} (${kind})`;
  return title || kind || "visual";
};

/** Parse a transition `at` like "0:04" or "4" → seconds. */
function parseAt(at: unknown): number | null {
  const s = String(at ?? "");
  const mmss = s.match(/(\d+):(\d{2})/);
  if (mmss) return num(mmss[1]) * 60 + num(mmss[2]);
  const n = s.match(/(\d+)/);
  return n ? num(n[1]) : null;
}

/**
 * Split a stored voice line into the spoken words + its bracketed footage cues.
 * The scripter writes cues inline like "…land in 20 minutes. [SCREEN RECORDING:
 * scrolling output]"; the editor shows the clean spoken text and renders the
 * cues as tags, so they're never raw text in the textarea.
 */
function splitCues(line: string): { spoken: string; cues: string[] } {
  const cues = footageCues(line);
  const spoken = line.replace(/\[[^\]]{2,80}\]/g, "").replace(/\s{2,}/g, " ").trim();
  return { spoken, cues };
}
/** Re-attach cues to edited spoken text so the stored line keeps them. */
function joinCues(spoken: string, cues: string[]): string {
  const tail = cues.map((c) => ` [${c}]`).join("");
  return `${spoken.trim()}${tail}`;
}

/** Coerce a draft's loose graph_specs → renderable RemotionAssetSpec[] (with brandColor override). */
function renderableSpecs(graphSpecs: unknown): RemotionAssetSpec[] {
  const arr = Array.isArray(graphSpecs) ? (graphSpecs as Record<string, unknown>[]) : [];
  return arr
    .map((raw) => {
      const spec = remotionAssetFromGraphSpec(raw);
      if (!spec) return null;
      return typeof raw.brandColor === "string" ? ({ ...spec, brandColor: raw.brandColor } as RemotionAssetSpec) : spec;
    })
    .filter((s): s is RemotionAssetSpec => s !== null);
}

/** Build a VideoClipRow (for the teardown modal) from an InspirationClip. */
function toClipRow(c: InspirationClip): VideoClipRow {
  return {
    id: c.id, platform: c.platform, external_id: c.external_id, source_kind: c.source_kind,
    author_handle: c.author_handle, caption: c.caption, url: c.url, thumb_url: c.thumb_url,
    views: c.views, likes: c.likes, comments: c.comments, author_follower_count: c.author_follower_count,
    deep_tier: c.deep_tier, posted_at: c.posted_at,
  };
}

/**
 * Nova's Drafts studio — the SAME three-pane studio the other lanes use
 * (list · editor · live preview ⇄ refine chat), tailored for video. It is the
 * video body of the shared <DraftsPanel>, built on the same shell
 * (useStudioColumns / useDraftSelection / StudioListPane) as the post studio —
 * not a parallel panel. The editor carries the timed storyboard, the script,
 * the Remotion visual track, and footage cues; the chat is the scripter itself
 * — it can rewrite lines and Apply them straight into the editor.
 */
export function VideoDraftsStudio({
  orgSlug,
  instanceId,
  drafts,
  generating = [],
}: {
  orgSlug: string;
  instanceId: string;
  drafts: VideoDraftRow[];
  generating?: VideoIdeaRow[];
}) {
  const [search, setSearch] = useState("");
  const [statusF, setStatusF] = useState<"all" | StatusKey>("all");
  const [paneMode, setPaneMode] = useState<"preview" | "chat">("preview");
  // The reel whose teardown is open (verify what Nova learned). Null = closed.
  const [verifyClip, setVerifyClip] = useState<InspirationClip | null>(null);
  const { wrapRef, mode, gridCols, listSticky, previewWrap } = useStudioColumns();

  const filtered = useMemo(
    () =>
      drafts.filter((d) => {
        if (statusF !== "all" && d.status !== statusF) return false;
        if (search) {
          const hay = (d.idea_hook + " " + (d.final_script ?? d.script)).toLowerCase();
          if (!hay.includes(search.toLowerCase())) return false;
        }
        return true;
      }),
    [drafts, statusF, search],
  );

  const { selectedId, setSelectedId, selected, goPrev, goNext, navPos } = useDraftSelection(drafts, filtered);

  // ── Editing buffers, lifted here so the refiner chat can Apply into them ──
  const identity = JSON.stringify([orgSlug, instanceId, selected?.id ?? null]);
  const [buffer, setBuffer] = useState<DraftBuffer | null>(() => selected ? draftBuffer(identity, selected) : null);
  // Refresh clean fields while keeping each unsaved field and its source metadata.
  useEffect(() => {
    setBuffer((current) => {
      if (!selected) return null;
      const saved = draftBuffer(identity, selected);
      if (!current || current.identity !== identity) return saved;
      return {
        ...current,
        ...(!current.linesDirty ? { beats: saved.beats, beatLines: saved.beatLines } : {}),
        ...(!current.scriptDirty ? { script: saved.script } : {}),
      };
    });
  }, [selected, identity]);
  const beatLines = buffer?.beatLines ?? [];
  const script = buffer?.script ?? "";
  const setBeatLines: Dispatch<SetStateAction<string[]>> = (update) => setBuffer((current) => current ? {
    ...current, beatLines: typeof update === "function" ? update(current.beatLines) : update, linesDirty: true,
  } : current);
  const setScript = (value: string) => setBuffer((current) => current ? { ...current, script: value, scriptDirty: true } : current);
  const confirm = (submitted: DraftBuffer, field: "lines" | "script") => setBuffer((current) => {
    if (!current || current.identity !== submitted.identity || current.selection !== submitted.selection) return current;
    if (field === "lines" && current.beats === submitted.beats && current.beatLines === submitted.beatLines) {
      return { ...current, linesDirty: false };
    }
    if (field === "script" && current.script === submitted.script) return { ...current, scriptDirty: false };
    return current;
  });

  // Nova proposed a script edit in chat → load it into the editor (dirty), for review + Save.
  const applyScriptEdit = (edit: ScriptEditProposal): boolean => {
    if (edit.beats?.some((b) => !Number.isInteger(b.index) || b.index < 0 || b.index >= beatLines.length)) return false;
    const nextLines = [...beatLines];
    for (const beat of edit.beats ?? []) nextLines[beat.index] = beat.line;
    const linesChanged = nextLines.some((line, index) => line !== beatLines[index]);
    const scriptChanged = typeof edit.fullScript === "string" && edit.fullScript !== script;
    if (!linesChanged && !scriptChanged) return false;
    if (linesChanged) {
      setBeatLines(nextLines);
    }
    if (scriptChanged) {
      setScript(edit.fullScript!);
    }
    setPaneMode("chat"); // keep the chat open so the founder sees the "applied" confirmation
    return true;
  };

  if (drafts.length === 0 && generating.length === 0) {
    return (
      <div className="card" style={{ textAlign: "center", padding: 40 }}>
        <p className="serif" style={{ fontSize: 24, margin: 0 }}>No scripts yet.</p>
        <p style={{ color: "var(--ink-muted)", fontSize: 13, maxWidth: "44ch", margin: "10px auto 0" }}>
          Approve an idea on the <strong>Ideas</strong> board — Nova drafts its structure, script, visuals, and
          suggested transitions/sounds here, grounded on your Brand Guide.
        </p>
      </div>
    );
  }

  return (
    <div ref={wrapRef} style={{ display: "grid", gridTemplateColumns: gridCols, gap: 16, alignItems: "start" }}>
      {/* ── LEFT: filterable list (shared shell) ── */}
      <StudioListPane
        search={search}
        onSearch={setSearch}
        statusValue={statusF}
        onStatus={(v) => setStatusF(v as typeof statusF)}
        statusOptions={[["all", "All"], ["draft", "Draft"], ["ready", "Ready"]]}
        generating={generating}
        count={filtered.length}
        onClearFilters={() => { setSearch(""); setStatusF("all"); }}
        sticky={listSticky}
        mode={mode}
      >
        {filtered.map((d) => (
          <ListCard key={d.id} draft={d} active={d.id === selectedId} onClick={() => setSelectedId(d.id)} />
        ))}
      </StudioListPane>

      {/* ── MIDDLE: editor ── */}
      {selected && buffer?.identity === identity ? (
        <Editor
          key={identity}
          orgSlug={orgSlug}
          draft={selected}
          buffer={buffer}
          setBeatLines={setBeatLines}
          setScript={setScript}
          onConfirmed={confirm}
          onRefine={() => setPaneMode("chat")}
          onCleared={() => setSelectedId((current) => current === selected.id ? null : current)}
          onPrev={goPrev}
          onNext={goNext}
          navPos={navPos}
          onVerifyClip={(c) => setVerifyClip(c)}
        />
      ) : (
        <div className="card" style={{ padding: 40, textAlign: "center", display: "flex", flexDirection: "column", alignItems: "center", gap: 14 }}>
          <Avatar role="video-intern" size={56} accent={NOVA_ACCENT} />
          <div className="serif" style={{ fontSize: 24, lineHeight: 1.1 }}>Nothing open</div>
          <div style={{ fontSize: 13, color: "var(--ink-muted)", maxWidth: "36ch" }}>Pick a draft from the list to edit it and preview it live.</div>
        </div>
      )}

      {/* ── RIGHT: live preview ⇄ refine chat (grounded in one card) ── */}
      <div style={previewWrap}>
        {paneMode === "chat" && selected ? (
          <div
            className="card"
            style={{ padding: 12, display: "flex", flexDirection: "column", height: mode >= 2 ? "calc(100vh - 220px)" : 560 }}
          >
            <div style={{ display: "flex", alignItems: "center", marginBottom: 10 }}>
              <span className="eyebrow">Talk to Nova · refining this draft</span>
              <button className="btn btn-sm" style={{ marginLeft: "auto" }} onClick={() => setPaneMode("preview")}>← Preview</button>
            </div>
            <div style={{ flex: 1, minHeight: 0 }}>
              <AgentChat
                agentId="video_intern"
                agentRole="video-intern"
                agentName="Nova"
                instanceId={instanceId}
                orgSlug={orgSlug}
                draftId={selected.id}
                fillHeight
                onApplyScriptEdit={applyScriptEdit}
              />
            </div>
          </div>
        ) : (
          <div className="card" style={{ padding: 12, display: "flex", flexDirection: "column", gap: 10 }}>
            <div style={{ display: "flex", alignItems: "center" }}>
              <span className="eyebrow">Live preview</span>
              {selected ? (
                <button className="btn btn-sm" style={{ marginLeft: "auto" }} onClick={() => setPaneMode("chat")}>Talk to Nova →</button>
              ) : null}
            </div>
            {selected ? (
              <div style={{ display: "flex", justifyContent: "center", padding: "8px 0" }}>
                <ReelPreview specs={renderableSpecs(selected.graph_specs)} hook={selected.idea_hook} width={mode === 1 ? 220 : 270} />
              </div>
            ) : (
              <div style={{ padding: 24, textAlign: "center", color: "var(--ink-soft)", fontSize: 12.5 }}>Pick a draft to preview it here.</div>
            )}
          </div>
        )}
      </div>

      {verifyClip ? (
        <ClipDetailModal clip={toClipRow(verifyClip)} orgSlug={orgSlug} instanceId={instanceId} onClose={() => setVerifyClip(null)} />
      ) : null}
    </div>
  );
}

function ListCard({ draft, active, onClick }: { draft: VideoDraftRow; active: boolean; onClick: () => void }) {
  const st = STATUS_META[draft.status] ?? STATUS_META.draft;
  return (
    <button
      onClick={onClick}
      style={{
        width: "100%", textAlign: "left", border: 0, cursor: "pointer",
        background: active ? "var(--paper-2)" : "transparent",
        boxShadow: active ? `0 0 0 1px color-mix(in oklch, ${NOVA_ACCENT} 40%, var(--rule))` : "none",
        borderRadius: 10, padding: "10px 11px", marginBottom: 4, display: "block",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 7, marginBottom: 5 }}>
        <span style={{ width: 7, height: 7, borderRadius: "50%", background: NOVA_ACCENT }} />
        <span style={{ fontFamily: "var(--mono)", fontSize: 9.5, letterSpacing: "0.06em", textTransform: "uppercase", color: "var(--ink-muted)" }}>Video</span>
        <span style={{ marginLeft: "auto", display: "inline-flex", alignItems: "center", gap: 4, fontFamily: "var(--mono)", fontSize: 9, color: st.color }}>
          <span style={{ width: 5, height: 5, borderRadius: "50%", background: st.color }} />
          {st.label}
        </span>
      </div>
      <div style={{ fontSize: 13, lineHeight: 1.3, color: "var(--ink)", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }}>
        {draft.idea_hook}
      </div>
    </button>
  );
}

function FootageChip({ cue }: { cue: string }) {
  return (
    <span
      title="Drop your own clip here when you film"
      style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 11.5, padding: "4px 10px", borderRadius: 999,
               border: "1px dashed var(--rule)", color: "var(--ink-muted)", background: "var(--paper-2)" }}
    >
      🎬 {cue}
    </span>
  );
}

/** Auto-growing textarea so voice lines are never cramped behind a scrollbar. */
const growTextarea: CSSProperties = {
  width: "100%", marginTop: 4, padding: "9px 11px", borderRadius: 8, border: 0,
  background: "var(--paper)", boxShadow: "0 0 0 0.5px var(--rule)",
  fontFamily: "inherit", fontSize: 14, lineHeight: 1.55, color: "var(--ink)",
  resize: "vertical", minHeight: 64,
  // field-sizing grows the box to its content (supported in modern Chromium/Safari).
  fieldSizing: "content",
} as CSSProperties;

function Editor({
  orgSlug,
  draft,
  buffer,
  setBeatLines,
  setScript,
  onConfirmed,
  onRefine,
  onCleared,
  onPrev,
  onNext,
  navPos,
  onVerifyClip,
}: {
  orgSlug: string;
  draft: VideoDraftRow;
  buffer: DraftBuffer;
  setBeatLines: Dispatch<SetStateAction<string[]>>;
  setScript: (v: string) => void;
  onConfirmed: (submitted: DraftBuffer, field: "lines" | "script") => void;
  onRefine: () => void;
  onCleared: () => void;
  onPrev?: () => void;
  onNext?: () => void;
  navPos: { idx: number; total: number } | null;
  onVerifyClip: (c: InspirationClip) => void;
}) {
  const [pending, start] = useTransition();
  const [message, setMessage] = useState<string | null>(null);
  const { beats, beatLines, script, linesDirty, scriptDirty } = buffer;
  const transitions = (Array.isArray(draft.transitions) ? draft.transitions : []) as Array<Record<string, unknown>>;
  const sounds = (Array.isArray(draft.sounds) ? draft.sounds : []) as Array<Record<string, unknown>>;
  const rawSpecs = (Array.isArray(draft.graph_specs) ? draft.graph_specs : []) as LooseSpec[];

  // Place each visual on its beat by timing; surface anything that can't be placed.
