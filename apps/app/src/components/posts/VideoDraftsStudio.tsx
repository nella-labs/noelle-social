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
