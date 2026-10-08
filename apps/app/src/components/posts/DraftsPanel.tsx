"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useTransition, type ChangeEvent, type CSSProperties } from "react";
import { Avatar } from "@/components/constellation/Avatar";
import { Field, inputStyle, VerifierTraceCard } from "./drafts-studio-chrome";
import { useStudioColumns, useDraftSelection, StudioListPane } from "./drafts-studio-shell";
import { VideoDraftsStudio } from "./VideoDraftsStudio";
import type { PostDraftRow, PostIdeaRow, ContentMediaRow, DrafterNoteRow } from "@/lib/posts-queries";
import type { VideoDraftRow, VideoIdeaRow } from "@/lib/video-studio-queries";
import { markReadyPost, dismissPost, markPostedPost, patchPostDraft, schedulePostIdea, uploadMedia, deleteMedia, loadPostThread } from "@/app/app/[orgSlug]/approvals/posts/actions";
import { LANE_BY_ID } from "./content-lanes";
import { stripLeadingHook, hookFromBody, joinHook } from "./hook-body";
import { InspirationRefs } from "./InspirationRefs";
import { DrafterChat } from "./DrafterChat";
import { StylePicker } from "./StylePicker";
import { useCopy } from "@/lib/use-copy";
import { mediaCopyPath } from "@/lib/media-path";

// The Drafts studio: a real workspace, not a list. Left = filterable drafts;
// middle = the field editor; right = a live, platform-accurate preview + the
// verifier trace. Nothing publishes — "ready" posts are copied out by hand
// (the interns are draft-only). "Refine" opens the side-by-side version editor.

const CATEGORIES = ["building", "studying", "workout", "gtm"] as const;
type Category = (typeof CATEGORIES)[number];
const isCategory = (v: string): v is Category => (CATEGORIES as readonly string[]).includes(v);

// Short, hydration-safe day label from a YYYY-MM-DD string (UTC, no locale drift).
function shortDay(ymd: string): string {
  return new Date(`${ymd}T00:00:00Z`).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
}

type StatusKey = "draft" | "ready" | "published";
const STATUS_META: Record<StatusKey, { label: string; color: string }> = {
  draft: { label: "Draft", color: "var(--ink-soft)" },
  ready: { label: "Ready", color: "var(--ok)" },
  published: { label: "Posted", color: "var(--accent)" },
};

type TextDraftsProps = {
  orgSlug: string;
  drafts: PostDraftRow[];
  /** Ideas awaiting drafts (approved/drafting) — shown as placeholders. */
  generating?: PostIdeaRow[];
  /** Deep-link a specific draft to open (from the week planner / Overview). */
  focusId?: string | null;
  /** Server-computed YYYY-MM-DD anchor for the Schedule chips (hydration-safe). */
  today: string;
  userName?: string;
  userHandle?: string;
  /** Pinned-style picker inputs (LinkedIn intern + its ingested sources); null hides it. */
  style?: {
    instanceId: string;
    sources: { handle: string; displayName: string | null }[];
    pinnedStyleHandle: string | null;
  } | null;
};

/**
 * The Drafts studio. One studio, every lane: the standard post studio (text)
 * and Nova's video studio share the SAME shell — the responsive 3-pane grid,
 * the filterable list rail (StudioListPane), and the selection/prev-next logic
 * (useStudioColumns / useDraftSelection, in ./drafts-studio-shell). Only the
 * editor body and the live-preview differ by lane. `lane="video"` delegates to
 * VideoDraftsStudio (the video body, built on the same shell); everything else
 * is the post studio below. The page renders ONE <DraftsPanel>, never a fork.
 */
export function DraftsPanel(
  props:
    | ({ lane?: "text" } & TextDraftsProps)
    | { lane: "video"; orgSlug: string; instanceId: string; drafts: VideoDraftRow[]; generating?: VideoIdeaRow[] },
) {
  if (props.lane === "video") {
    return (
      <VideoDraftsStudio
        orgSlug={props.orgSlug}
        instanceId={props.instanceId}
        drafts={props.drafts}
        generating={props.generating}
      />
    );
  }
  return <TextDraftsStudio {...props} />;
}

function TextDraftsStudio({
  orgSlug,
  drafts,
  generating = [],
  focusId = null,
  today,
  userName = "Your profile",
  userHandle = "",
  style = null,
}: TextDraftsProps) {
  const [search, setSearch] = useState("");
  const [statusF, setStatusF] = useState<"all" | StatusKey>("all");
  const [platF, setPlatF] = useState<"all" | string>("all");
  const { wrapRef, mode, gridCols, listSticky, previewWrap } = useStudioColumns();

  // Right pane: live preview ⇄ drafter chat (toggled by Refine).
  const [paneMode, setPaneMode] = useState<"preview" | "chat">("preview");
  // Lazily-loaded thread + media for the selected draft's idea.
  const [sidecar, setSidecar] = useState<{ ideaId: string; notes: DrafterNoteRow[]; media: ContentMediaRow[] } | null>(null);

  const platforms = useMemo(() => [...new Set(drafts.map((d) => d.platform))], [drafts]);
  const showPlatFilter = platforms.length > 1;

  const filtered = useMemo(() => {
    return drafts.filter((d) => {
      if (statusF !== "all" && d.status !== statusF) return false;
      if (showPlatFilter && platF !== "all" && d.platform !== platF) return false;
      if (search) {
        const hay = ((d.draft_hook ?? d.hook ?? "") + " " + (d.final_body ?? d.body)).toLowerCase();
        if (!hay.includes(search.toLowerCase())) return false;
      }
      return true;
    });
  }, [drafts, statusF, platF, search, showPlatFilter]);

  const { selectedId, setSelectedId, selected, goPrev, goNext, navPos } = useDraftSelection(drafts, filtered, focusId);

  // Load the selected draft's drafter thread + attached media on demand.
  const selectedIdeaId = selected?.idea_id ?? null;
  const reloadSidecar = useCallback(() => {
    if (!selectedIdeaId) { setSidecar(null); return; }
    loadPostThread({ orgSlug, ideaId: selectedIdeaId }).then((res) => {
      if (res.ok) setSidecar({ ideaId: selectedIdeaId, notes: res.notes, media: res.media });
    });
  }, [orgSlug, selectedIdeaId]);
  useEffect(() => { reloadSidecar(); }, [reloadSidecar]);
  const selMedia = selected && sidecar?.ideaId === selected.idea_id ? sidecar.media.filter((m) => m.draft_id === selected.id) : [];
  const selNotes = selected && sidecar?.ideaId === selected.idea_id ? sidecar.notes : [];

  if (drafts.length === 0 && generating.length === 0) {
    return (
      <div className="card" style={{ textAlign: "center", padding: 40 }}>
        <p className="serif" style={{ fontSize: 24, margin: 0 }}>No generated posts yet.</p>
        <p style={{ color: "var(--ink-muted)", fontSize: 13, maxWidth: "44ch", margin: "10px auto 0" }}>
          Open the <strong>Ideas</strong> board and hit <strong>Draft</strong> — the finished posts (3 X + 1 LinkedIn per idea) land here for review.
        </p>
      </div>
    );
  }

  const platformChips = showPlatFilter ? (
    <div style={{ display: "flex", gap: 5, marginTop: 8, flexWrap: "wrap" }}>
      <PlatChip label="All" active={platF === "all"} onClick={() => setPlatF("all")} />
      {platforms.map((p) => {
        const lane = LANE_BY_ID[p];
        return <PlatChip key={p} label={lane?.label ?? p} color={lane?.color} active={platF === p} onClick={() => setPlatF(p)} />;
      })}
    </div>
  ) : null;

  return (
    <div ref={wrapRef} style={{ display: "grid", gridTemplateColumns: gridCols, gap: 16, alignItems: "start" }}>
      {/* ── LEFT: filterable list (shared shell) ── */}
      <StudioListPane
        search={search}
        onSearch={setSearch}
        statusValue={statusF}
        onStatus={(v) => setStatusF(v as typeof statusF)}
        statusOptions={[["all", "All"], ["draft", "Draft"], ["ready", "Ready"], ["published", "Posted"]]}
        extraFilter={platformChips}
        generating={generating}
        count={filtered.length}
        onClearFilters={() => { setSearch(""); setStatusF("all"); setPlatF("all"); }}
        sticky={listSticky}
        mode={mode}
      >
        {filtered.map((d) => (
          <ListCard key={d.id} draft={d} active={d.id === selectedId} onClick={() => setSelectedId(d.id)} />
        ))}
      </StudioListPane>

      {/* ── MIDDLE: editor ── */}
      {selected ? (
        <Editor key={selected.id} orgSlug={orgSlug} draft={selected} today={today}
                media={selMedia} onMediaChanged={reloadSidecar} onRefine={() => setPaneMode("chat")}
                onCleared={() => setSelectedId(null)} onPrev={goPrev} onNext={goNext} navPos={navPos} />
      ) : (
        <div className="card" style={{ padding: 40, textAlign: "center", display: "flex", flexDirection: "column", alignItems: "center", gap: 14 }}>
          <Avatar role="content" size={56} />
          <div className="serif" style={{ fontSize: 24, lineHeight: 1.1 }}>Nothing open</div>
          <div style={{ fontSize: 13, color: "var(--ink-muted)", maxWidth: "36ch" }}>Pick a draft from the list to edit it and preview it live.</div>
        </div>
      )}

      {/* ── RIGHT: live preview ⇄ drafter chat ── */}
      <div style={previewWrap}>
        {paneMode === "chat" && selected ? (
          <>
            <div style={{ display: "flex", alignItems: "center", marginBottom: 8 }}>
              <span className="eyebrow">Talk to the drafter</span>
              <button className="btn btn-sm" style={{ marginLeft: "auto" }} onClick={() => setPaneMode("preview")}>← Preview</button>
            </div>
            {style && style.sources.length > 0 && (
              <div style={{ marginBottom: 10 }}>
                <StylePicker
