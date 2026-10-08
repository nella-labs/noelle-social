"use client";

import { useMemo, useState } from "react";
import { ClipThumb } from "@/app/app/[orgSlug]/agents/[instanceId]/watchlist/ClipThumb";
import { reachMultiple, reachTone } from "@/lib/video-metrics";
import type { VideoClipRow } from "@/lib/video-queries";
import { fmtCount, ReachBadge, REACH_TONE_COLOR } from "./video-reach";
import { ClipDetailModal } from "./ClipDetailModal";

// Nova's Discover board, made browsable: sort + filter + reach-tier colour over
// the harvested clips. Client-side (the corpus is already loaded, ≤200 clips),
// so it's instant — no round trips. Mirrors the shared lane's filter-chip
// pattern (.idea-tag) so it reads like the rest of the studio.

type SortKey = "views" | "reach" | "recent" | "likes";
type SourceFilter = "all" | "creator" | "niche";
type ReachFilter = "all" | "strong" | "solid" | "audience";

const SORTS: Array<{ key: SortKey; label: string }> = [
  { key: "views", label: "Views" },
  { key: "reach", label: "Views/followers" },
  { key: "recent", label: "Recent" },
  { key: "likes", label: "Likes" },
];

const REACH_FILTERS: Array<{ key: ReachFilter; label: string }> = [
  { key: "all", label: "All ratios" },
  { key: "strong", label: "Views/followers ≥1×" },
  { key: "solid", label: "Views/followers 0.3–1×" },
  { key: "audience", label: "Views/followers <0.3×" },
];

function measuredFirst(a: number | null, b: number | null): number {
  return a === null ? (b === null ? 0 : 1) : b === null ? -1 : b - a;
}

function Chip({ on, onClick, children }: { on: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button type="button" className={`idea-tag${on ? " idea-tag--on" : ""}`} onClick={onClick} aria-pressed={on}>
      {children}
    </button>
  );
}

export function VideoDiscoverGrid({
  clips,
  orgSlug,
  instanceId,
}: {
  clips: VideoClipRow[];
  orgSlug: string;
  instanceId: string;
}) {
  const [sort, setSort] = useState<SortKey>("views");
  const [source, setSource] = useState<SourceFilter>("all");
  const [reach, setReach] = useState<ReachFilter>("all");
  const [open, setOpen] = useState<VideoClipRow | null>(null);

  const hasNiche = useMemo(() => clips.some((c) => c.source_kind === "niche"), [clips]);

  const view = useMemo(() => {
    const withReach = clips.map((c) => ({ c, rm: reachMultiple(c.views, c.author_follower_count) }));
    const filtered = withReach.filter(({ c, rm }) => {
      if (source !== "all" && c.source_kind !== source) return false;
      if (reach !== "all") {
        if (rm == null) return false;
        if (reachTone(rm) !== reach) return false;
      }
      return true;
    });
    filtered.sort((a, b) => {
      switch (sort) {
        case "reach":
          return measuredFirst(a.rm, b.rm);
        case "likes":
          return measuredFirst(a.c.likes, b.c.likes);
        case "recent": {
          const ta = a.c.posted_at ? Date.parse(a.c.posted_at) : null;
          const tb = b.c.posted_at ? Date.parse(b.c.posted_at) : null;
          return measuredFirst(ta, tb);
        }
        default:
          return measuredFirst(a.c.views, b.c.views);
      }
    });
    return filtered.map((x) => x.c);
  }, [clips, sort, source, reach]);

  return (
    <div>
      {/* Controls — sort + source + reach tier, in the shared filter-chip idiom. */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          flexWrap: "wrap",
          marginBottom: 14,
          paddingBottom: 12,
          borderBottom: "0.5px solid var(--rule)",
        }}
      >
        <span style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--ink-soft)", letterSpacing: "0.04em" }}>
          SORT
        </span>
        <div className="row" style={{ gap: 4, flexWrap: "wrap" }}>
          {SORTS.map((s) => (
            <Chip key={s.key} on={sort === s.key} onClick={() => setSort(s.key)}>
              {s.label}
            </Chip>
          ))}
        </div>

        <span style={{ width: 1, height: 16, background: "var(--rule)", margin: "0 2px" }} />

        <span style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--ink-soft)", letterSpacing: "0.04em" }}>
          FILTER
        </span>
        <div className="row" style={{ gap: 4, flexWrap: "wrap" }}>
          <Chip on={source === "all"} onClick={() => setSource("all")}>
            All sources
          </Chip>
          <Chip on={source === "creator"} onClick={() => setSource("creator")}>
            Creators
          </Chip>
          {hasNiche ? (
            <Chip on={source === "niche"} onClick={() => setSource("niche")}>
              Niches
            </Chip>
          ) : null}
        </div>
        <div className="row" style={{ gap: 4, flexWrap: "wrap" }}>
          {REACH_FILTERS.map((r) => (
            <Chip key={r.key} on={reach === r.key} onClick={() => setReach(r.key)}>
              {r.label}
            </Chip>
          ))}
        </div>

        <span style={{ marginLeft: "auto", fontFamily: "var(--mono)", fontSize: 10, color: "var(--ink-soft)" }}>
          {view.length} of {clips.length}
        </span>
      </div>

      {view.length === 0 ? (
        <div className="card clay-flat ideas-empty">
          <h3 className="serif">No clips match</h3>
          <p>Loosen the filters above to see more of the harvested reels.</p>
        </div>
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(170px, 1fr))", gap: 14 }}>
          {view.map((c) => (
            <ClipCard key={c.id} clip={c} onOpen={() => setOpen(c)} />
          ))}
        </div>
      )}

      {open ? (
        <ClipDetailModal clip={open} orgSlug={orgSlug} instanceId={instanceId} onClose={() => setOpen(null)} />
      ) : null}
    </div>
  );
}

function ClipCard({ clip, onOpen }: { clip: VideoClipRow; onOpen: () => void }) {
  const rm = reachMultiple(clip.views, clip.author_follower_count);
  // Shared ratio thresholds tint the edge; unknown measurements stay untinted.
  const edge = rm != null ? REACH_TONE_COLOR[reachTone(rm)] : "transparent";
  return (
    <button
      type="button"
      onClick={onOpen}
      className="card"
      style={{
        padding: 0,
        overflow: "hidden",
        display: "block",
        color: "inherit",
        textAlign: "left",
        cursor: "pointer",
        width: "100%",
        border: "none",
        borderTop: `2px solid ${edge}`,
      }}
    >
      <div style={{ position: "relative" }}>
        <ClipThumb src={clip.thumb_url} handle={clip.author_handle} />
        <div style={{ position: "absolute", top: 8, left: 8, display: "flex", gap: 5 }}>
          {clip.deep_tier ? (
            <span
              style={{
                fontFamily: "var(--mono)",
                fontSize: 8.5,
                letterSpacing: "0.06em",
                textTransform: "uppercase",
                padding: "2px 6px",
                borderRadius: 999,
                background: "var(--ink)",
                color: "var(--paper)",
              }}
            >
              deep
            </span>
          ) : null}
        </div>
        {/* Signals the card opens Nova's teardown — without it the thumbnail
            reads as "play the reel", so the analysis was undiscoverable. */}
        <span
          style={{
            position: "absolute",
            top: 8,
            right: 8,
            display: "flex",
            alignItems: "center",
            gap: 4,
            fontFamily: "var(--mono)",
            fontSize: 9,
            letterSpacing: "0.04em",
            textTransform: "uppercase",
            padding: "2px 7px",
            borderRadius: 999,
            background: "rgba(20,16,8,0.7)",
            color: "#fff",
          }}
        >
          ⊞ teardown
        </span>
        <span
          style={{
            position: "absolute",
            bottom: 8,
            right: 8,
            fontFamily: "var(--mono)",
            fontSize: 10,
            padding: "2px 7px",
            borderRadius: 999,
            background: "rgba(20,16,8,0.7)",
            color: "#fff",
          }}
        >
          ▸ {fmtCount(clip.views)}
        </span>
      </div>
      <div style={{ padding: "10px 12px" }}>
        <div
          style={{
            fontFamily: "var(--mono)",
            fontSize: 11,
            color: "var(--ink)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          @{clip.author_handle}
        </div>
        <div
          style={{
            fontSize: 11,
            color: "var(--ink-muted)",
            marginTop: 4,
            lineHeight: 1.35,
            display: "-webkit-box",
            WebkitLineClamp: 2,
            WebkitBoxOrient: "vertical",
            overflow: "hidden",
          }}
        >
          {clip.caption || "—"}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 8 }}>
          <span className="tag" style={{ height: 18 }}>
            {clip.source_kind}
          </span>
          <ReachBadge multiple={rm} views={clip.views} followers={clip.author_follower_count} size="xs" />
          <span style={{ marginLeft: "auto", fontFamily: "var(--mono)", fontSize: 9.5, color: "var(--ink-soft)" }}>
            ♥ {fmtCount(clip.likes)}
          </span>
        </div>
      </div>
    </button>
  );
}
