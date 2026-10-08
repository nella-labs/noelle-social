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
