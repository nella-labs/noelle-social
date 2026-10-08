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
                  orgSlug={orgSlug}
                  instanceId={style.instanceId}
                  sources={style.sources}
                  current={style.pinnedStyleHandle}
                />
              </div>
            )}
            <DrafterChat key={selected.idea_id} orgSlug={orgSlug} ideaId={selected.idea_id} notes={selNotes} />
          </>
        ) : (
          <>
            <div className="eyebrow" style={{ marginBottom: 8 }}>Live preview</div>
            {selected ? (
              <Preview draft={selected} userName={userName} userHandle={userHandle} />
            ) : (
              <div className="card" style={{ padding: 24, textAlign: "center", color: "var(--ink-soft)", fontSize: 12.5 }}>
                Pick a draft to preview it here.
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

// ─── List card ───────────────────────────────────────────────────────────
function ListCard({ draft, active, onClick }: { draft: PostDraftRow; active: boolean; onClick: () => void }) {
  const lane = LANE_BY_ID[draft.platform] ?? LANE_BY_ID.x;
  const st = STATUS_META[(draft.status as StatusKey)] ?? STATUS_META.draft;
  const hook = draft.draft_hook || draft.hook || "Untitled draft";
  return (
    <button onClick={onClick}
            style={{ width: "100%", textAlign: "left", border: 0, cursor: "pointer",
                     background: active ? "var(--paper-2)" : "transparent",
                     boxShadow: active ? "0 0 0 1px color-mix(in oklch, var(--accent) 40%, var(--rule))" : "none",
                     borderRadius: 10, padding: "10px 11px", marginBottom: 4, display: "block" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 7, marginBottom: 5 }}>
        <span style={{ width: 7, height: 7, borderRadius: "50%", background: lane.color }} />
        <span style={{ fontFamily: "var(--mono)", fontSize: 9.5, letterSpacing: "0.06em", textTransform: "uppercase", color: "var(--ink-muted)" }}>{lane.label}</span>
        <span style={{ marginLeft: "auto", display: "inline-flex", alignItems: "center", gap: 4, fontFamily: "var(--mono)", fontSize: 9, color: st.color }}>
          <span style={{ width: 5, height: 5, borderRadius: "50%", background: st.color }} />{st.label}
        </span>
      </div>
      <div style={{ fontSize: 13, lineHeight: 1.3, color: "var(--ink)",
                    display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }}>
        {hook}
      </div>
      {draft.suggested_day && (
        <div style={{ marginTop: 6, display: "inline-flex", alignItems: "center", gap: 4, fontFamily: "var(--mono)", fontSize: 9,
                      color: "var(--ink-muted)", background: "var(--paper-deep)", padding: "1px 7px", borderRadius: 999 }}>
          ◷ {shortDay(draft.suggested_day)}
        </div>
      )}
    </button>
  );
}

// ─── Editor ──────────────────────────────────────────────────────────────
function Editor({
  orgSlug, draft, today, media, onMediaChanged, onCleared, onPrev, onNext, navPos, onRefine,
}: {
  orgSlug: string;
  draft: PostDraftRow;
  today: string;
  media: ContentMediaRow[];
  onMediaChanged: () => void;
  onCleared: () => void;
  onPrev?: () => void;
  onNext?: () => void;
  navPos: { idx: number; total: number } | null;
  onRefine: () => void;
}) {
  const lane = LANE_BY_ID[draft.platform] ?? LANE_BY_ID.x;
  const isX = draft.platform === "x";
  const [hook, setHook] = useState(draft.draft_hook ?? "");
  // LinkedIn/Reddit split the editor into Hook + Content: `content` edits the post
  // BODY minus its leading hook line (so the hook isn't shown twice) and save
  // recombines them (joinHook) into byte-identical `body`.
  const [content, setContent] = useState(stripLeadingHook(draft.final_body ?? draft.body, draft.draft_hook));
  // X is one atomic ≤280 post — no hook/content split. Edit the whole thing in a
  // single "Post" field; its first line doubles as the stored hook (list + regen).
  const [post, setPost] = useState(draft.final_body ?? draft.body);
  const [cta, setCta] = useState(draft.cta ?? "");
  const [notes, setNotes] = useState(draft.notes ?? "");
  const [category, setCategory] = useState<Category | "">(isCategory(draft.category ?? "") ? (draft.category as Category) : "");
  const [pending, startTransition] = useTransition();
  const [saved, setSaved] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const { copy: copyText, copiedKey, copyError } = useCopy();
  const flash = () => { setSaved(true); setTimeout(() => setSaved(false), 1400); };

  const isReady = draft.status === "ready";
  const isPosted = draft.status === "published";

  // The full post body — what actually gets posted/stored — and the hook line,
  // resolved per platform. For X the single "Post" field IS the body and its first
  // line is the hook; otherwise it's the recombined hook + content.
  const fullBody = isX ? post : joinHook(hook, content);
  const effectiveHook = isX ? hookFromBody(post) : hook;
  const origBody = draft.final_body ?? draft.body;

  const patchChanged = async () => {
    const res = await patchPostDraft({
      orgSlug,
      draftId: draft.id,
      hook: effectiveHook !== (draft.draft_hook ?? "") ? effectiveHook : undefined,
      body: fullBody !== origBody ? fullBody : undefined,
      cta: cta !== (draft.cta ?? "") ? cta : undefined,
      notes: notes !== (draft.notes ?? "") ? notes : undefined,
      category: category && category !== draft.category ? category : undefined,
    });
    if (!res.ok) setMsg(res.error.message);
    return res.ok;
  };

  const saveDraft = () => { setMsg(null); startTransition(async () => { if (await patchChanged()) flash(); }); };
  const markReady = () => {
    setMsg(null);
    startTransition(async () => {
      if (!(await patchChanged())) return;
      const res = await markReadyPost({ orgSlug, draftId: draft.id, editedBody: fullBody });
      if (!res.ok) setMsg(res.error.message); else flash();
    });
  };
  const markPosted = () => {
    setMsg(null);
    startTransition(async () => {
      if (!(await patchChanged())) return;
      const res = await markPostedPost({ orgSlug, draftId: draft.id });
      if (!res.ok) setMsg(res.error.message);
    });
  };
  // Scheduling is idea-level (the X + LinkedIn variants of an idea move together).
  const schedule = (day: string | null) => {
    setMsg(null);
    startTransition(async () => {
      const res = await schedulePostIdea({ orgSlug, ideaId: draft.idea_id, day });
      if (!res.ok) setMsg(res.error.message); else flash();
    });
  };
  // The board shows the LATEST version per (idea, platform); dismiss the whole
  // set (scope:"set") so the card leaves the board instead of resurfacing an
  // older version (which made these look undeletable).
  const dismiss = () => { startTransition(async () => { const res = await dismissPost({ orgSlug, id: draft.id, target: "draft", scope: "set" }); if (res.ok) onCleared(); else setMsg(res.error.message); }); };
  const copy = () => {
    setMsg(null);
    startTransition(async () => {
      if (!(await patchChanged())) return;
      await copyText([fullBody, cta].filter(Boolean).join("\n\n"));
    });
  };

  return (
    <div className="card" style={{ padding: 0, overflow: "hidden" }}>
      {/* header */}
      <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "13px 18px", borderBottom: "1px solid var(--rule-soft)" }}>
        <Avatar role={lane.role ?? "x-intern"} size={26} accent={lane.color} />
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 13.5, fontWeight: 500 }}>Post · {lane.label}</div>
          <div style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--ink-muted)" }}>{lane.agent} · {draft.status}</div>
        </div>
        <div style={{ marginLeft: "auto", display: "flex", gap: 8, alignItems: "center" }}>
          {saved && <span style={{ fontSize: 11, color: "var(--ok)", fontFamily: "var(--mono)" }}>✓ saved</span>}
          {navPos && (
            <div style={{ display: "inline-flex", alignItems: "center", gap: 2 }}>
              <button className="btn btn-sm" onClick={onPrev} disabled={!onPrev} aria-label="Previous draft" style={{ padding: "0 9px" }}>‹</button>
              <span style={{ fontFamily: "var(--mono)", fontSize: 10.5, color: "var(--ink-muted)", minWidth: 40, textAlign: "center" }}>{navPos.idx} / {navPos.total}</span>
              <button className="btn btn-sm" onClick={onNext} disabled={!onNext} aria-label="Next draft" style={{ padding: "0 9px" }}>›</button>
            </div>
          )}
          <button className="btn btn-sm" onClick={onRefine} title="Talk to the drafter">✎ Refine</button>
          <button onClick={dismiss} disabled={pending} title="Remove this draft" aria-label="Remove draft"
                  style={{ width: 30, height: 28, border: 0, borderRadius: 7, background: "transparent", color: "var(--ink-soft)", cursor: "pointer", fontSize: 14 }}
                  onMouseEnter={(e) => { e.currentTarget.style.background = "color-mix(in oklch, var(--danger) 14%, var(--paper))"; e.currentTarget.style.color = "var(--danger)"; }}
                  onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; e.currentTarget.style.color = "var(--ink-soft)"; }}>🗑</button>
        </div>
      </div>

      <div style={{ padding: 18, display: "flex", flexDirection: "column", gap: 16 }}>
        {draft.verifier_meta && <VerifierTraceCard meta={draft.verifier_meta} />}

        {isX ? (
          // X is one atomic ≤280 post — a single field for the whole thing, no
          // dead "Content" box. Mirrors the live preview (no separate hook line).
          <Field label="Post" hint={`${fullBody.length} / 280`}>
            <textarea value={post} onChange={(e) => setPost(e.target.value)} rows={7}
                      placeholder="Write the whole post. ≤280 — the first line is the hook."
                      style={{ ...inputStyle, resize: "vertical", lineHeight: 1.6 }} />
          </Field>
        ) : (
          <>
            <Field label="Hook">
              <input value={hook} onChange={(e) => setHook(e.target.value)} placeholder="Open with a verb…" style={inputStyle} />
            </Field>

            <Field label="Content">
              <textarea value={content} onChange={(e) => setContent(e.target.value)} rows={7}
                        placeholder="Write the body. Concrete > abstract." style={{ ...inputStyle, resize: "vertical", lineHeight: 1.6 }} />
            </Field>
          </>
        )}

        {/* What this post drew from — watchlist people, the source post, vault. */}
        {draft.inspiration_refs?.length ? <InspirationRefs refs={draft.inspiration_refs} /> : null}

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
          <Field label="CTA"><input value={cta} onChange={(e) => setCta(e.target.value)} placeholder="Link in bio · DMs open…" style={inputStyle} /></Field>
          <Field label="Category">
            <select value={category} onChange={(e) => setCategory(e.target.value as Category | "")} style={{ ...inputStyle, height: 36, cursor: "pointer" }}>
              <option value="">—</option>
              {CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </Field>
        </div>

        <Field label="Schedule" hint="moves the X + LinkedIn set together">
          <ScheduleChips today={today} value={draft.suggested_day ?? null} onChange={schedule} disabled={pending} />
        </Field>

        <Field label="Media" hint="attach an image / video">
          <MediaField orgSlug={orgSlug} draftId={draft.id} platform={draft.platform} media={media} onChanged={onMediaChanged} />
        </Field>

        <Field label="Notes" hint="private — guides the drafter">
          <textarea value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Angle, audience, do/don't…" rows={2}
                    style={{ ...inputStyle, resize: "vertical", fontStyle: "italic" }} />
        </Field>

        {(msg || copyError) && <span role="status" style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--danger)" }}>{msg || copyError}</span>}

        {/* actions */}
        <div style={{ display: "flex", alignItems: "center", gap: 10, paddingTop: 4, borderTop: "1px dashed var(--rule)", flexWrap: "wrap" }}>
          <div style={{ marginLeft: "auto", display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button className="btn btn-sm" onClick={saveDraft} disabled={pending}>Save draft</button>
            {isPosted ? (
              <span style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--accent)", alignSelf: "center" }}>posted ✓</span>
            ) : isReady ? (
              <>
                <button className="btn btn-sm" onClick={copy} disabled={pending}>{copiedKey ? "Copied ✓" : "Copy post"}</button>
                <button className="btn btn-sm btn-primary" onClick={markPosted} disabled={pending}>Mark posted</button>
              </>
            ) : (
              <button className="btn btn-sm btn-accent" onClick={markReady} disabled={pending}>{pending ? "Saving…" : "Mark ready"}</button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Schedule chips (today → +6) ─────────────────────────────────────────
function addDaysYmd(ymd: string, i: number): string {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + i);
  return d.toISOString().slice(0, 10);
}
function ScheduleChips({ today, value, onChange, disabled }: { today: string; value: string | null; onChange: (d: string | null) => void; disabled?: boolean }) {
  const days = Array.from({ length: 7 }, (_, i) => {
    const date = addDaysYmd(today, i);
    const d = new Date(`${date}T00:00:00Z`);
    return { i, date, dow: d.toLocaleDateString("en-US", { weekday: "short", timeZone: "UTC" }), num: d.getUTCDate() };
  });
  return (
    <div style={{ display: "flex", gap: 4 }}>
      <button onClick={() => onChange(null)} disabled={disabled} title="Unscheduled" style={chipBtn(value == null, "var(--ink-soft)")}>—</button>
      {days.map((d) => (
        <button key={d.i} onClick={() => onChange(d.date)} disabled={disabled} title={`${d.dow} ${d.num}`} style={chipBtn(value === d.date, "var(--accent)")}>
          <span style={{ fontSize: 8, opacity: 0.7, display: "block", lineHeight: 1 }}>{d.i === 0 ? "Tod" : d.dow.slice(0, 2)}</span>
          <span style={{ fontSize: 11, lineHeight: 1.2 }}>{d.num}</span>
        </button>
      ))}
    </div>
  );
}
function chipBtn(active: boolean, color: string): CSSProperties {
  return {
    flex: 1, minWidth: 0, height: 38, border: 0, borderRadius: 7, cursor: "pointer",
    background: active ? color : "var(--paper-2)", color: active ? "#fff" : "var(--ink-muted)",
    boxShadow: active ? "none" : "0 0 0 0.5px var(--rule)",
    fontFamily: "var(--mono)", display: "grid", placeItems: "center", padding: 0,
  };
}

// ─── Media attach (per-draft) ────────────────────────────────────────────
const MAX_MEDIA_BYTES = 11 * 1024 * 1024;
async function fileToBase64(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  return btoa(binary);
}
function MediaField({ orgSlug, draftId, platform, media, onChanged }: {
  orgSlug: string; draftId: string; platform: string; media: ContentMediaRow[]; onChanged: () => void;
}) {
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const { copiedKey, copy } = useCopy();

  function onPick(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setMsg(null);
    if (file.size > MAX_MEDIA_BYTES) { setMsg("That file is too large (max ~11MB)."); if (inputRef.current) inputRef.current.value = ""; return; }
    const kind = file.type.startsWith("video") ? "video" : file.type.startsWith("image") ? "image" : "other";
    start(async () => {
      try {
        const dataBase64 = await fileToBase64(file);
        const res = await uploadMedia({ orgSlug, kind, mimeType: file.type || "application/octet-stream", dataBase64, filename: file.name, draftId });
        if (!res.ok) setMsg(`Couldn't upload: ${res.error.message}`); else onChanged();
      } catch { setMsg("Couldn't read that file."); }
      if (inputRef.current) inputRef.current.value = "";
    });
  }
  function remove(id: string) {
    setMsg(null);
    start(async () => { const res = await deleteMedia({ orgSlug, id }); if (!res.ok) setMsg(`Couldn't remove: ${res.error.message}`); else onChanged(); });
  }

  return (
    <div>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "flex-start" }}>
        {media.map((m) => {
          const copied = copiedKey === m.id;
          return (
            <div key={m.id} style={{ width: 64, display: "flex", flexDirection: "column", gap: 4 }}>
              <div style={{ position: "relative", width: 64, height: 64, borderRadius: 8, overflow: "hidden", boxShadow: "0 0 0 0.5px var(--rule)", background: "var(--paper-2)" }}>
                {m.kind === "video" && m.url ? (
                  <video src={m.url} style={{ width: "100%", height: "100%", objectFit: "cover" }} muted />
                ) : m.url ? (
                  <div role="img" aria-label={m.caption ?? "attached media"}
                       style={{ width: "100%", height: "100%", backgroundImage: `url(${JSON.stringify(m.url)})`, backgroundSize: "cover", backgroundPosition: "center" }} />
                ) : (
                  <span style={{ fontFamily: "var(--mono)", fontSize: 8, color: "var(--ink-soft)", display: "grid", placeItems: "center", height: "100%" }}>no preview</span>
                )}
                <button onClick={() => remove(m.id)} disabled={pending} aria-label="Remove media"
                        style={{ position: "absolute", top: 2, right: 2, width: 18, height: 18, borderRadius: "50%", border: 0, cursor: "pointer",
                                 background: "rgba(20,16,8,.7)", color: "#fff", fontSize: 11, lineHeight: 1, display: "grid", placeItems: "center" }}>✕</button>
              </div>
              <button type="button" onClick={() => copy(mediaCopyPath(m.url), m.id)} disabled={!m.url}
                      title={m.url ? "Copy the path to this file" : "No path yet"}
                      style={{ width: 64, height: 18, border: 0, borderRadius: 5, cursor: m.url ? "pointer" : "default", padding: 0,
                               background: copied ? "var(--ok)" : "var(--paper-2)", color: copied ? "#fff" : "var(--ink-muted)",
                               boxShadow: copied ? "none" : "0 0 0 0.5px var(--rule)", fontFamily: "var(--mono)", fontSize: 9, letterSpacing: "0.02em",
                               transition: "background .15s, color .15s" }}>
                {copied ? "✓ copied" : "Copy path"}
              </button>
            </div>
          );
        })}
        <label className="btn btn-sm" style={{ cursor: "pointer" }}>
          {pending ? "…" : media.length ? "+ Add" : "+ Image / video"}
          <input ref={inputRef} type="file" accept="image/*,video/*" onChange={onPick} disabled={pending} hidden />
        </label>
      </div>
      {media.length === 0 && (
        <div style={{ fontSize: 10.5, color: "var(--ink-soft)", marginTop: 6 }}>
          Attach an image{platform === "linkedin" ? " or the video for this post" : ""}. Draft-only — you post by hand.
        </div>
      )}
      {msg && <span style={{ fontFamily: "var(--mono)", fontSize: 10.5, color: "var(--danger)", display: "block", marginTop: 6 }}>{msg}</span>}
    </div>
  );
}

// ─── Live preview ────────────────────────────────────────────────────────
function ph(t: string, fallback: string) { return t && t.trim() ? t : fallback; }

function Preview({ draft, userName, userHandle }: { draft: PostDraftRow; userName: string; userHandle: string }) {
  const hookRaw = draft.draft_hook ?? "";
  const full = draft.final_body ?? draft.body;
  const body = stripLeadingHook(full, hookRaw); // full post minus its leading hook line
  const didStrip = body !== full;
  const cta = draft.cta ?? "";
  // LinkedIn: bold hook line then the rest. Reddit: hook is the post TITLE, body
  // below it. X: no separate hook field — show the full post (hook is line 1).
  if (draft.platform === "linkedin")
    return <LinkedInPreview userName={userName} hook={didStrip ? hookRaw : ""} content={body} cta={cta} />;
  if (draft.platform === "reddit")
    return <RedditPreview userHandle={userHandle} hook={hookRaw} content={didStrip ? body : full} cta={cta} />;
  return <XPreview userName={userName} userHandle={userHandle} content={full} cta={cta} />;
}

function XPreview({ userName, userHandle, content, cta }: { userName: string; userHandle: string; content: string; cta: string }) {
  const body = [content, cta].filter((s) => s && s.trim()).join("\n\n");
  return (
    <div className="card" style={{ padding: 16 }}>
      <div style={{ display: "flex", gap: 10 }}>
        <Avatar role="you" size={40} accent="var(--paper)" />
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ display: "flex", alignItems: "baseline", gap: 6 }}>
            <span style={{ fontWeight: 700, fontSize: 14 }}>{userName}</span>
            <span style={{ color: "var(--ink-muted)", fontFamily: "var(--mono)", fontSize: 12 }}>{userHandle}</span>
          </div>
          <div style={{ marginTop: 6, fontSize: 14.5, lineHeight: 1.5, color: body ? "var(--ink)" : "var(--ink-soft)", whiteSpace: "pre-wrap", fontStyle: body ? "normal" : "italic" }}>
            {ph(body, "Your post renders here.")}
          </div>
