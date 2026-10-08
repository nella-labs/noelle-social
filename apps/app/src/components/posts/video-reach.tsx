import { fmtReach, reachTone, reachTitle } from "@/lib/video-metrics";

// Shared presentational bits for Nova's video lane — pure components (no
// server-only imports), so both the server lane (InspirationStrip) and the
// client Discover grid can use them without duplicating the reach badge.

export const fmtCount = (n: number | null): string =>
  n === null ? "unknown" : n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1_000 ? `${(n / 1_000).toFixed(1)}k` : String(n);

export const REACH_TONE_COLOR: Record<ReturnType<typeof reachTone>, string> = {
  strong: "var(--ok)",
  solid: "var(--warn)",
  audience: "var(--ink-soft)",
};

/**
 * The reach-multiple chip — views ÷ the creator's follower count. Tells you at a
 * glance how recorded views compare with the captured follower count.
 * Renders only when both measurements and the derived ratio are known.
 */
export function ReachBadge({
  multiple,
  views,
  followers,
  size = "sm",
}: {
  multiple: number | null;
  views: number | null;
  followers: number | null;
  size?: "sm" | "xs";
}) {
  if (multiple == null || followers == null || views == null) return null;
  const tone = reachTone(multiple);
  const color = REACH_TONE_COLOR[tone];
  return (
    <span
      title={reachTitle(multiple, views, followers)}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 3,
        fontFamily: "var(--mono)",
        fontSize: size === "xs" ? 9 : 10,
        letterSpacing: "0.03em",
        padding: size === "xs" ? "1px 5px" : "2px 7px",
        borderRadius: 999,
        background: "var(--paper-2)",
        boxShadow: `inset 0 0 0 1px ${color}`,
        color,
        whiteSpace: "nowrap",
      }}
    >
      {fmtReach(multiple)} views/followers
    </span>
  );
}
