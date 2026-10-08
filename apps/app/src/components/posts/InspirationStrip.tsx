import { ClipThumb } from "@/app/app/[orgSlug]/agents/[instanceId]/watchlist/ClipThumb";
import type { InspirationClip } from "@/lib/video-studio-queries";
import { fmtCount, ReachBadge } from "./video-reach";

/**
 * "Inspired by" — the harvested reels Nova built an idea/script from, each with
 * its real performance (views) and the reach multiple vs the creator's
 * following. Shared by the lane's Ideas/Drafts so it reads identically. Pure
 * component (ClipThumb is the only client bit), usable server- or client-side.
 */
export function InspirationStrip({
  clips,
  heading = "Inspired by",
  onOpen,
}: {
  clips: InspirationClip[];
  heading?: string;
  /**
   * When provided, clicking a reel opens its teardown (verify what Nova learned)
   * instead of just linking out. The ↗ still links to the real source reel.
   */
  onOpen?: (clip: InspirationClip) => void;
}) {
  if (clips.length === 0) return null;
  const rowStyle = { display: "flex", alignItems: "center", gap: 10, padding: 7, borderRadius: 10, color: "inherit", textDecoration: "none", minWidth: 0 } as const;
  return (
    <div style={{ marginTop: 4 }}>
      <div className="studio-sub" style={{ display: "flex", alignItems: "center", gap: 6 }}>
        {heading}
        <span style={{ fontFamily: "var(--mono)", fontSize: 9.5, color: "var(--ink-soft)", fontWeight: 400 }}>
          {onOpen ? "tap to verify the teardown · ↗ opens the reel" : "recorded views / captured followers"}
        </span>
      </div>
      <div style={{ display: "grid", gap: 7 }}>
        {clips.map((c) => {
          const inner = (
            <>
              <div style={{ width: 38, height: 50, flexShrink: 0, borderRadius: 6, overflow: "hidden" }}>
                <ClipThumb src={c.thumb_url} handle={c.author_handle} />
              </div>
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                  <span style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--ink)" }}>@{c.author_handle}</span>
                  <span style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--ink-muted)" }}>▸ {fmtCount(c.views)}</span>
                  {c.author_follower_count != null ? (
                    <span style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--ink-soft)" }}>· {fmtCount(c.author_follower_count)} followers</span>
                  ) : null}
                  <ReachBadge multiple={c.reach_multiple} views={c.views} followers={c.author_follower_count} size="xs" />
                </div>
                {c.caption ? (
                  <div style={{ fontSize: 11, color: "var(--ink-muted)", marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {c.caption}
                  </div>
                ) : null}
              </div>
            </>
          );

          // Verify mode: the row opens the teardown; a nested ↗ still opens the
          // real reel (stopPropagation so it doesn't also open the teardown).
          if (onOpen) {
            return (
              <div
                key={c.id}
                role="button"
                tabIndex={0}
                onClick={() => onOpen(c)}
                onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onOpen(c); } }}
                className="clay-flat"
                style={{ ...rowStyle, cursor: "pointer" }}
              >
                {inner}
                <a
                  href={c.url}
                  target="_blank"
                  rel="noreferrer"
                  onClick={(e) => e.stopPropagation()}
                  title="Open the real reel"
                  style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--ink-soft)", flexShrink: 0, textDecoration: "none" }}
                >
                  ↗
                </a>
              </div>
            );
          }

          return (
            <a key={c.id} href={c.url} target="_blank" rel="noreferrer" className="clay-flat" style={rowStyle}>
              {inner}
              <span style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--ink-soft)", flexShrink: 0 }}>↗</span>
            </a>
          );
        })}
      </div>
    </div>
  );
}
