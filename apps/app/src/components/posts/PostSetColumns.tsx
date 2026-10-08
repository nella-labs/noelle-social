"use client";

import { useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { PostDraftRow, PostIdeaRow, ContentMediaRow } from "@/lib/posts-queries";
import {
  generatePost,
  patchPostDraft,
  dismissPost,
  uploadMedia,
  deleteMedia,
} from "@/app/app/[orgSlug]/approvals/posts/actions";

// The cross-platform post SET editor — content-pipeline's detail view in noelle's
// design. One idea fans out into side-by-side platform columns: X (3 versions)
// and LinkedIn (1), mirroring the content-pipeline GeneratorRun shape. Each
// column cycles its versions (Prev/Next/+ Version) and edits the full anatomy:
// HOOK, CONTENT (+Copy), CTA, MEDIA (attach an image or — for LinkedIn — the
// video), a STATUS lifecycle (Draft/Written/Scheduled/Posted), CATEGORY, POSTED
// URL, and Notes. Nothing publishes; "Posted" just archives the variant.

type Counter = "total" | "firstline";

// The subset of patch fields a column can edit (orgSlug/draftId added by save()).
// The editor is intentionally minimal now — Hook + Content only; status/category/
// CTA/posted-URL/notes were removed as clutter (status lives on the Posts board).
type PatchFields = {
  hook?: string | null;
  body?: string;
};

interface PlatformMeta {
  label: string;
  accent: string;
  charLimit: number;
  counter: Counter;
}

const PLATFORM_META: Record<string, PlatformMeta> = {
  x: { label: "X", accent: "#1d9bf0", charLimit: 280, counter: "total" },
  linkedin: { label: "LinkedIn", accent: "#0a66c2", charLimit: 210, counter: "firstline" },
  reddit: { label: "Reddit", accent: "#ff4500", charLimit: 40000, counter: "total" },
};

// ~11MB upload ceiling (matches the api-vm base64 body budget).
const MAX_MEDIA_BYTES = 11 * 1024 * 1024;

// X first, then LinkedIn, then anything else — the sharp short post beside the long one.
const PLATFORM_ORDER = ["x", "linkedin", "reddit"];
const ALL_PLATFORMS = ["x", "linkedin", "reddit"];
function orderPlatforms(platforms: string[]): string[] {
  const rank = (p: string) => {
    const i = PLATFORM_ORDER.indexOf(p);
    return i === -1 ? 99 : i;
  };
  return [...new Set(platforms)].sort((a, b) => rank(a) - rank(b));
}

export function PostSetColumns({
  orgSlug,
  idea,
  drafts,
  media = [],
}: {
  orgSlug: string;
  idea: PostIdeaRow;
  drafts: PostDraftRow[];
  media?: ContentMediaRow[];
}) {
  const platforms = useMemo(
    () => orderPlatforms(idea.target_platforms?.length ? idea.target_platforms : [idea.platform]),
    [idea.target_platforms, idea.platform],
  );

  // Versions per platform, oldest → newest (v1 = first draft). Query is newest-first.
  const byPlatform = useMemo(() => {
    const m: Record<string, PostDraftRow[]> = {};
    for (const p of platforms) m[p] = [];
    for (const d of drafts) (m[d.platform] ??= []).push(d);
    for (const p of Object.keys(m)) m[p] = [...m[p]!].reverse();
    return m;
  }, [drafts, platforms]);

  // Media now attaches to a specific draft (post variant). Group by draft_id so
  // each column's editor shows + manages just its own image/video.
  const mediaByDraft = useMemo(() => {
    const m: Record<string, ContentMediaRow[]> = {};
    for (const row of media) {
      if (!row.draft_id) continue;
      (m[row.draft_id] ??= []).push(row);
    }
    return m;
  }, [media]);

  const noDrafts = drafts.length === 0;
  const ideaGenerating = idea.status === "approved" || idea.status === "drafting";
  // Only the platform(s) actually being (re)drafted show "writing…". A
  // per-platform Refine sets pending_platforms=[that platform]; a full generate
  // leaves it null → every target platform is generating. Without this gate, both
  // columns falsely claimed to be writing when you refined only one.
  const pending = idea.pending_platforms;
  const platformGenerating = (p: string) =>
    ideaGenerating && (pending == null || pending.includes(p));

  return (
    <div className="post-set">
      {noDrafts && (
        <GenerateAll orgSlug={orgSlug} ideaId={idea.id} platforms={platforms} generating={ideaGenerating} />
      )}
      <div className="post-set-grid" data-cols={platforms.length}>
        {platforms.map((p) => {
          const versions = byPlatform[p] ?? [];
          return (
            <PlatformColumn
              // Key by version count so a freshly-generated version snaps to latest,
              // while a plain auto-refresh (same count) keeps the manual position.
              key={`${p}-${versions.length}`}
              orgSlug={orgSlug}
              ideaTitle={idea.hook}
              ideaId={idea.id}
              platform={p}
              versions={versions}
              mediaByDraft={mediaByDraft}
              generating={platformGenerating(p)}
            />
          );
        })}
      </div>
      <AddPlatform
        orgSlug={orgSlug}
        ideaId={idea.id}
        missing={ALL_PLATFORMS.filter((p) => !platforms.includes(p))}
      />
    </div>
  );
}

// Add a platform the idea doesn't target yet (e.g. create a Reddit post). The
// generate route unions it into target_platforms + drafts it; the column appears
// on refresh.
function AddPlatform({
  orgSlug,
  ideaId,
  missing,
}: {
  orgSlug: string;
  ideaId: string;
  missing: string[];
}) {
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);
  const router = useRouter();
  if (missing.length === 0) return null;
  function add(p: string) {
    setMsg(null);
    start(async () => {
      const res = await generatePost({ orgSlug, ideaId, platforms: [p as "linkedin" | "x" | "reddit"] });
      if (!res.ok) setMsg(res.error.message);
      else router.refresh();
    });
  }
  return (
    <div className="post-set-addplatform">
      <span className="ink-muted" style={{ fontSize: 12 }}>Add a platform:</span>
      {missing.map((p) => (
        <button key={p} type="button" className="btn btn-sm btn-ghost" onClick={() => add(p)} disabled={pending}>
          {pending ? "…" : `+ ${PLATFORM_META[p]?.label ?? p}`}
        </button>
      ))}
      {msg && <span className="ideas-msg mono">{msg}</span>}
    </div>
  );
}

function GenerateAll({
  orgSlug,
  ideaId,
  platforms,
  generating,
}: {
  orgSlug: string;
  ideaId: string;
  platforms: string[];
  generating: boolean;
}) {
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);
  const router = useRouter();
  const labels = platforms.map((p) => PLATFORM_META[p]?.label ?? p).join(" + ");

  if (generating) {
    return <div className="clay-flat regen-banner mono">Generating {labels}…</div>;
  }
  return (
    <div className="clay-flat post-set-generate">
      <p className="serif">No posts generated yet.</p>
      <p>Generate the {labels} variants from this idea — each in its platform&apos;s voice.</p>
      <button
        className="btn btn-primary"
        disabled={pending}
        onClick={() =>
          start(async () => {
            setMsg(null);
            const res = await generatePost({ orgSlug, ideaId });
            if (!res.ok) setMsg(res.error.message);
            else router.refresh();
          })
        }
      >
        {pending ? "Generating…" : `Generate ${labels}`}
      </button>
      {msg && <span className="ideas-msg mono">{msg}</span>}
    </div>
  );
}

function PlatformColumn({
  orgSlug,
  ideaTitle,
  ideaId,
  platform,
  versions,
  mediaByDraft,
  generating,
}: {
  orgSlug: string;
  ideaTitle: string;
  ideaId: string;
  platform: string;
  versions: PostDraftRow[];
  mediaByDraft: Record<string, ContentMediaRow[]>;
  generating: boolean;
}) {
  const meta = PLATFORM_META[platform] ?? { label: platform, accent: "#888", charLimit: 1000, counter: "total" as Counter };
  const [idx, setIdx] = useState(Math.max(0, versions.length - 1));
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);
  const [refineOpen, setRefineOpen] = useState(false);
  const [guidance, setGuidance] = useState("");
  const router = useRouter();

  const selectedIdx = Math.min(idx, versions.length - 1);
  const selected = versions[selectedIdx] ?? null;

  // Generate another version of this platform. An optional `guide` is a one-off
  // steer ("make it punchier") the drafter applies to the new version.
  function addVersion(guide?: string) {
    setMsg(null);
    start(async () => {
      const res = await generatePost({
        orgSlug,
        ideaId,
        platforms: [platform as "linkedin" | "x" | "reddit"],
        guidance: guide?.trim() || undefined,
      });
      if (!res.ok) setMsg(res.error.message);
      else {
        setRefineOpen(false);
        setGuidance("");
        router.refresh();
      }
    });
  }

  return (
    <section className="platform-column clay" style={{ ["--col-accent" as string]: meta.accent }}>
      <header className="platform-column__bar">
        <span className="platform-column__name" style={{ color: meta.accent }}>{meta.label}</span>
        <span className="mono platform-column__ver">
          {versions.length > 0 ? `v${selectedIdx + 1} / ${versions.length}` : "—"}
        </span>
        <div className="platform-column__nav">
          <button
            className="btn btn-ghost btn-xs"
            onClick={() => setIdx((i) => Math.max(0, i - 1))}
            disabled={selectedIdx <= 0}
            title={`Previous ${meta.label} version`}
            aria-label="Previous version"
          >
            ‹
          </button>
          <button
            className="btn btn-ghost btn-xs"
            onClick={() => setIdx((i) => Math.min(versions.length - 1, i + 1))}
            disabled={selectedIdx >= versions.length - 1 || versions.length === 0}
            title={`Next ${meta.label} version`}
            aria-label="Next version"
          >
            ›
          </button>
          <button
            className="btn btn-xs"
            onClick={() => setRefineOpen((o) => !o)}
            disabled={pending}
            title="Generate another version — optionally tell it what to change"
          >
            {refineOpen ? "Close" : "✎ Refine"}
          </button>
        </div>
      </header>

      {refineOpen && (
        <div className="platform-column__refine">
          <textarea
            className="input"
            placeholder={`What should this ${meta.label} version change? (optional — blank = a fresh take)`}
            value={guidance}
            onChange={(e) => setGuidance(e.target.value)}
            rows={2}
            autoFocus
          />
          <div className="platform-column__refine-row">
            <button className="btn btn-sm btn-primary" onClick={() => addVersion(guidance)} disabled={pending}>
              {pending ? "Generating…" : guidance.trim() ? "Refine → new version" : "New version"}
            </button>
            <span className="ink-muted" style={{ fontSize: 11 }}>
              Adds a new version; the current ones stay.
            </span>
          </div>
        </div>
      )}

      {generating && versions.length > 0 && (
        <div className="platform-column__generating mono">✎ writing a new {meta.label} version…</div>
      )}

      {versions.length > 1 && (
        <div className="platform-column__dots">
          {versions.map((v, i) => (
            <button
              key={v.id}
              className={`platform-column__dot${i === selectedIdx ? " is-active" : ""}`}
              onClick={() => setIdx(i)}
              title={`${meta.label} version ${i + 1}`}
              aria-label={`${meta.label} version ${i + 1}`}
            />
          ))}
        </div>
      )}

      {msg && <span className="ideas-msg mono">{msg}</span>}

      {selected ? (
        <DraftEditor
          key={selected.id}
          orgSlug={orgSlug}
          draft={selected}
          meta={meta}
          ideaTitle={ideaTitle}
          media={mediaByDraft[selected.id] ?? []}
        />
      ) : generating ? (
        <div className="clay-flat platform-column__empty">
          <p className="mono">Generating {meta.label}…</p>
        </div>
      ) : (
        <div className="clay-flat platform-column__empty">
          <p>No {meta.label} version yet.</p>
          <button className="btn btn-sm btn-primary" onClick={() => addVersion()} disabled={pending}>
            {pending ? "Generating…" : `Generate ${meta.label}`}
          </button>
        </div>
      )}
    </section>
  );
}

function DraftEditor({
  orgSlug,
  draft,
  meta,
  ideaTitle,
  media,
}: {
  orgSlug: string;
  draft: PostDraftRow;
  meta: PlatformMeta;
  ideaTitle: string;
  media: ContentMediaRow[];
}) {
  const [hook, setHook] = useState(draft.draft_hook ?? "");
  const [body, setBody] = useState(draft.final_body ?? draft.body);
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const router = useRouter();

  // X counts the whole post; LinkedIn counts only the first line (before "…see more").
  const count = meta.counter === "firstline" ? (body.split("\n")[0]?.length ?? 0) : body.length;
  const over = count > meta.charLimit;
  const counterLabel = meta.counter === "firstline" ? `first line ${count}/${meta.charLimit}` : `${count}/${meta.charLimit}`;

  function save(patch: PatchFields) {
    setMsg(null);
    start(async () => {
      const res = await patchPostDraft({ orgSlug, draftId: draft.id, ...patch });
      if (!res.ok) setMsg(res.error.message);
      else router.refresh();
    });
  }

  const saveHook = () => { if (hook !== (draft.draft_hook ?? "")) save({ hook: hook || null }); };
  const saveBody = () => { if (body !== (draft.final_body ?? draft.body)) save({ body }); };
  function dismiss() {
    setMsg(null);
    start(async () => {
      const res = await dismissPost({ orgSlug, id: draft.id, target: "draft" });
      if (!res.ok) setMsg(res.error.message);
      else router.refresh();
    });
  }
  async function copy() {
    try {
      await navigator.clipboard.writeText(body);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setMsg("Couldn't copy — select and copy by hand.");
    }
  }

  return (
    <div className="draft-editor">
      <div className="draft-editor__head">
        <span className="draft-editor__vname" style={{ color: meta.accent }}>{meta.label}</span>
        <span className={over ? "mono draft-editor__count is-over" : "mono draft-editor__count"}>{counterLabel}</span>
        {draft.quality_passed != null && (
          <span className={`mono${draft.quality_passed ? "" : " idea-quality--fail"}`}>
            {draft.quality_passed ? "✓ verified" : "⚠ review"}
          </span>
        )}
      </div>

      <p className="draft-editor__title serif">{ideaTitle} <span className="draft-editor__title-plat">({meta.label})</span></p>

      <label className="field">
        <span className="field__label">Hook</span>
        <input
          className="input field__input"
          value={hook}
          placeholder="Opening line that grabs attention"
          onChange={(e) => setHook(e.target.value)}
          onBlur={saveHook}
        />
      </label>

      <div className="field">
        <div className="field__labelrow">
          <span className="field__label">Content</span>
          <button type="button" className="btn btn-ghost btn-xs" onClick={copy}>
            {copied ? "Copied ✓" : "Copy"}
          </button>
        </div>
        <textarea
          className="post-draft-body input"
          value={body}
          onChange={(e) => setBody(e.target.value)}
          onBlur={saveBody}
          rows={Math.min(18, Math.max(6, Math.ceil(body.length / 50)))}
          aria-label={`${meta.label} content`}
        />
      </div>

      <DraftMedia
        orgSlug={orgSlug}
        draftId={draft.id}
        media={media}
        platform={meta.label}
      />

      {msg && <span className="ideas-msg mono">{msg}</span>}

      <div className="draft-editor__foot">
        {pending && <span className="mono draft-editor__saving">saving…</span>}
        <button className="btn btn-ghost btn-sm" onClick={dismiss} disabled={pending}>
          Dismiss
        </button>
      </div>
    </div>
  );
}

// Per-post media: attach an image (any platform) or a video (the "LinkedIn
// video"). Uploads bind to THIS draft (content_media.draft_id) so each variant
// carries its own asset; nothing auto-publishes.
async function fileToBase64(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  return btoa(binary);
}

function DraftMedia({
  orgSlug,
  draftId,
  media,
  platform,
}: {
  orgSlug: string;
  draftId: string;
  media: ContentMediaRow[];
  platform: string;
}) {
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const router = useRouter();

  function onPick(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setMsg(null);
    if (file.size > MAX_MEDIA_BYTES) {
      setMsg("That file is too large (max ~11MB).");
      if (inputRef.current) inputRef.current.value = "";
      return;
    }
    const kind = file.type.startsWith("video") ? "video" : file.type.startsWith("image") ? "image" : "other";
    start(async () => {
      try {
        const dataBase64 = await fileToBase64(file);
        const res = await uploadMedia({
          orgSlug,
          kind,
          mimeType: file.type || "application/octet-stream",
          dataBase64,
          filename: file.name,
          draftId,
        });
        if (!res.ok) setMsg(`Couldn't upload: ${res.error.message}`);
        else router.refresh();
      } catch {
        setMsg("Couldn't read that file.");
      }
      if (inputRef.current) inputRef.current.value = "";
    });
  }

  function remove(id: string) {
    setMsg(null);
    start(async () => {
      const res = await deleteMedia({ orgSlug, id });
      if (!res.ok) setMsg(`Couldn't remove: ${res.error.message}`);
      else router.refresh();
    });
  }

  return (
    <div className="field">
      <div className="field__labelrow">
        <span className="field__label">Media</span>
        <label className="btn btn-ghost btn-xs draft-media__add">
          {pending ? "…" : media.length ? "+ Add" : "+ Image / video"}
          <input
            ref={inputRef}
            type="file"
            accept="image/*,video/*"
            onChange={onPick}
            disabled={pending}
            hidden
          />
        </label>
      </div>
      {media.length > 0 ? (
        <ul className="draft-media">
          {media.map((m) => (
            <li key={m.id} className="draft-media__item">
              {m.kind === "video" && m.url ? (
                <video src={m.url} controls className="draft-media__preview" />
              ) : m.url ? (
                // Raw <img>: m.url is operator-attached media on an arbitrary host.
                <img src={m.url} alt={m.caption ?? "attached media"} className="draft-media__preview" />
              ) : (
                <span className="draft-media__missing mono">no preview</span>
              )}
              <button
                type="button"
                className="draft-media__del"
                onClick={() => remove(m.id)}
                disabled={pending}
                title="Remove this media"
                aria-label="Remove media"
              >
                ✕
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="draft-media__hint">
          Attach an image{platform === "LinkedIn" ? " or the video for this post" : ""}. Draft-only — you post by hand.
        </p>
      )}
      {msg && <span className="ideas-msg mono">{msg}</span>}
    </div>
  );
}
