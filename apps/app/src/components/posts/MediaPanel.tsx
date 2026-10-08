"use client";

import { useMemo, useRef, useState, useTransition } from "react";
import { CONTENT_MEDIA_MAX_BYTES } from "@noelle/contracts";
import type { ContentMediaRow } from "@/lib/posts-queries";
import { uploadMedia, deleteMedia } from "@/app/app/[orgSlug]/approvals/posts/actions";
import { CopyButton } from "@/components/approvals/CopyButton";
import { mediaCopyPath } from "@/lib/media-path";

// The Media library (content-pipeline parity): raw uploads grouped by day, with
// a Clips / B-rolls split (video vs image), search, group-by + sort controls,
// and video thumbnails (play, filename, date, size). Upload reads the file in
// the browser, base64-encodes it, and POSTs through the content-media action.

type Tab = "clips" | "brolls";
type Sort = "newest" | "oldest";
type Group = "day" | "none";

const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// Deterministic (UTC, no locale) so it's hydration-safe — render-time toLocale
// aborts hydration and kills the page (see reference_hydration_kills_page).
function dayKey(createdAt: string): string {
  return createdAt.slice(0, 10); // YYYY-MM-DD
}
function dayLabel(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  return `${DOW[d.getUTCDay()]}, ${MON[d.getUTCMonth()]} ${d.getUTCDate()}`;
}
function sizeLabel(bytes: number | null): string {
  if (!bytes) return "";
  const mb = bytes / (1024 * 1024);
  return mb >= 1 ? `${mb.toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}
function mediaName(m: ContentMediaRow): string {
  if (m.caption) return m.caption;
  if (m.url) {
    const seg = m.url.split("/").pop()?.split("?")[0];
    if (seg) {
      try { return decodeURIComponent(seg); } catch { return seg; }
    }
  }
  return `${m.kind}-${m.id.slice(0, 8)}`;
}

async function fileToBase64(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  return btoa(binary);
}

export function MediaPanel({
  orgSlug,
  media,
  platform = null,
}: {
  orgSlug: string;
  media: ContentMediaRow[];
  platform?: "linkedin" | "x" | "reddit" | null;
}) {
  const [tab, setTab] = useState<Tab>("clips");
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<Sort>("newest");
  const [group, setGroup] = useState<Group>("day");
  const [pending, startTransition] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Clips = video, B-rolls = image/other (matches content-pipeline's split).
  const tabbed = useMemo(
    () => media.filter((m) => (tab === "clips" ? m.kind === "video" : m.kind !== "video")),
    [media, tab],
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const rows = q ? tabbed.filter((m) => mediaName(m).toLowerCase().includes(q)) : tabbed;
    return [...rows].sort((a, b) =>
      sort === "newest" ? b.created_at.localeCompare(a.created_at) : a.created_at.localeCompare(b.created_at),
    );
  }, [tabbed, query, sort]);

  // Group into day buckets (or one bucket when grouping is off), ordered by sort.
  const groups = useMemo(() => {
    if (group === "none") return [{ key: "", label: "", items: filtered }];
    const map = new Map<string, ContentMediaRow[]>();
    for (const m of filtered) {
      const k = dayKey(m.created_at);
      (map.get(k) ?? map.set(k, []).get(k)!).push(m);
    }
    const keys = [...map.keys()].sort((a, b) => (sort === "newest" ? b.localeCompare(a) : a.localeCompare(b)));
    return keys.map((k) => ({ key: k, label: dayLabel(k), items: map.get(k)! }));
  }, [filtered, group, sort]);

  const totalBytes = tabbed.reduce((acc, m) => acc + (m.bytes ?? 0), 0);

  function onPick(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setMsg(null);
    if (file.size > CONTENT_MEDIA_MAX_BYTES) {
      setMsg("That file is too large (max ~11MB).");
      if (inputRef.current) inputRef.current.value = "";
      return;
    }
    startTransition(async () => {
      try {
        const dataBase64 = await fileToBase64(file);
        const res = await uploadMedia({
          orgSlug,
          kind: file.type.startsWith("video/") ? "video" : file.type.startsWith("image/") ? "image" : "other",
          mimeType: file.type || "application/octet-stream",
          dataBase64,
          filename: file.name,
          caption: file.name,
          platform: platform ?? undefined,
        });
        setMsg(res.ok ? "Uploaded." : `Couldn't upload: ${res.error.message}`);
      } catch {
        setMsg("Couldn't read that file.");
      }
      if (inputRef.current) inputRef.current.value = "";
    });
  }

  function remove(id: string) {
    setMsg(null);
    startTransition(async () => {
      const res = await deleteMedia({ orgSlug, id });
      if (!res.ok) setMsg(`Couldn't delete: ${res.error.message}`);
    });
  }

  return (
    <div className="media-panel">
      <div className="media-head">
        <span className="mono media-stat">
          {tabbed.length} {tab === "clips" ? "clips" : "b-rolls"}
          {totalBytes > 0 ? ` · ${sizeLabel(totalBytes)}` : ""}
        </span>
        <div className="media-tabs">
          <button className={`media-tab${tab === "clips" ? " is-active" : ""}`} onClick={() => setTab("clips")}>Clips</button>
          <button className={`media-tab${tab === "brolls" ? " is-active" : ""}`} onClick={() => setTab("brolls")}>B-rolls</button>
        </div>
      </div>

      <div className="media-toolbar action-bar-phone">
        <input
          className="input media-search"
          placeholder="Search files…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Search media"
        />
        <select className="input media-select" value={group} onChange={(e) => setGroup(e.target.value as Group)} aria-label="Group">
          <option value="day">Group by day</option>
          <option value="none">No grouping</option>
        </select>
        <select className="input media-select" value={sort} onChange={(e) => setSort(e.target.value as Sort)} aria-label="Sort">
          <option value="newest">Newest first</option>
          <option value="oldest">Oldest first</option>
        </select>
        <label className={`btn btn-primary${pending ? " is-busy" : ""}`}>
          {pending ? "Uploading…" : "Upload"}
          <input ref={inputRef} type="file" accept="image/*,video/*" onChange={onPick} disabled={pending} hidden />
        </label>
      </div>

      {msg && <span className="ideas-msg mono">{msg}</span>}

      {filtered.length === 0 ? (
        <div className="clay-flat ideas-empty">
          <p className="serif">{query ? "No files match your search." : `No ${tab === "clips" ? "clips" : "b-rolls"} yet.`}</p>
          {!query && <p>Upload images or video to attach to your posts — shared across LinkedIn, X, and Reddit.</p>}
        </div>
      ) : (
        groups.map((g) => (
          <section key={g.key || "all"} className="media-group">
            {g.label && (
              <div className="media-group__head">
                <span className="media-group__day">{g.label}</span>
                <span className="mono media-group__count">{g.items.length} {g.items.length === 1 ? "file" : "files"}</span>
              </div>
            )}
            <ul className="media-grid">
              {g.items.map((m) => (
                <MediaCard key={m.id} media={m} pending={pending} onRemove={() => remove(m.id)} />
              ))}
            </ul>
          </section>
        ))
      )}
    </div>
  );
}

function MediaCard({
  media,
  pending,
  onRemove,
}: {
  media: ContentMediaRow;
  pending: boolean;
  onRemove: () => void;
}) {
  const [playing, setPlaying] = useState(false);
  const isVideo = media.kind === "video";
  const available = media.status === "ready" && Boolean(media.url);
  const deleting = media.status === "deleting";
  // External (content-pipeline) clips are read-only — no Delete.
  const isExternal = media.id.startsWith("ext:");
  return (
    <li className="clay media-card">
      <div className="media-thumb-wrap">
        {!available ? <span className="mono media-meta" role="status">{deleting ? "Deletion pending" : "File unavailable"}</span> : isVideo ? (
          playing ? (
            <video src={media.url ?? undefined} controls autoPlay className="media-thumb" />
          ) : (
            <button type="button" className="media-thumb-play" onClick={() => setPlaying(true)} aria-label="Play">
              {/* preload metadata renders the first frame as a poster */}
              <video src={media.url ?? undefined} preload="metadata" className="media-thumb" muted />
              <span className="media-thumb-play__icon">▶</span>
            </button>
          )
        ) : (
          // User-uploaded media of arbitrary origin/size — a plain img is right here.
          <img src={media.url ?? ""} alt={mediaName(media)} className="media-thumb" />
        )}
      </div>
      <div className="media-card__foot">
        <span className="media-name" title={mediaName(media)}>{mediaName(media)}</span>
        <div className="media-card__meta">
          <span className="mono media-meta">{dayLabel(dayKey(media.created_at))}</span>
          <span className="mono media-meta">{sizeLabel(media.bytes)}</span>
        </div>
        <div className="media-card__actions">
          {available && media.url && <CopyButton text={mediaCopyPath(media.url)} label="Copy path" />}
          {!isExternal && (
            <button className="btn btn-ghost btn-xs media-del" onClick={onRemove} disabled={pending}>
              {deleting ? "Retry delete" : "Delete"}
            </button>
          )}
        </div>
      </div>
    </li>
  );
}
