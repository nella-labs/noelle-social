// Single source of truth for "is this the X home timeline?" and "which tab
// should the run drive?". Shared by the background feed-guard (ensureOnFeed /
// ensureOnHome + tab selection), so the definition of "on the feed" never
// drifts between callers. (Ported from the LinkedIn actuator's lib/feed.ts.)
//
// Why this matters: feed-liking and the idle ambient browse must happen on
// x.com/home. Every path that leaves the tab elsewhere — doComment parking it on
// a /status/ permalink, a stale-rect click navigating onto a profile or a t.co
// link, or the operator opening their own x.com tabs — otherwise strands the
// loop off-feed, where it finds no fresh timeline tweets and the like counter
// freezes. In scheduled mode a reply leaves the tab on the replied tweet's
// /status/ permalink, and the operator can drive the tab anywhere; standalone
// likes then wheel-and-locate a thread/profile page, where the few visible
// tweets are quickly exhausted (or already liked) — the loop looks busy while
// the like counter freezes.

/**
 * True if a full URL is the X home timeline. Matches https://x.com/home (and
 * the legacy twitter.com domain) followed by "/", end-of-string, "?" or "#" —
 * anchored so a profile like x.com/homedepot never matches.
 */
export function isFeedUrl(url: string | null | undefined): boolean {
  if (!url) return false;
  return /^https?:\/\/(?:www\.)?(?:x|twitter)\.com\/home([/?#]|$)/i.test(url);
}

/**
 * True if a `location.pathname` is the home timeline. Accepts "/home" and
 * "/home/…". For content-side callers that only see the pathname.
 */
export function isFeedPath(pathname: string | null | undefined): boolean {
  if (!pathname) return false;
  return /^\/home([/?#]|$)/i.test(pathname);
}

/** Minimal shape of a chrome.tabs.Tab for tab selection (id + url). */
export interface TabRef {
  id?: number;
  url?: string;
}

/**
 * Pick which X tab a run should actuate, given every open x.com/twitter.com
 * tab and the tab (if any) already pinned to this run:
 *
 *  1. If a tab was pinned for the run and it is still open, KEEP it — the loop
 *     must not hop tabs mid-run just because another x.com tab now sorts first
 *     (that is how an operator's own profile tab can hijack the run). A pinned
 *     tab that has wandered off /home stays chosen; the feed guard pulls that
 *     same tab back.
 *  2. Otherwise prefer a tab actually ON the home timeline — never a stray
 *     profile/notifications tab that merely sorts first.
 *  3. Otherwise fall back to the first X tab (may be off-feed; the feed guard
 *     will pull it back on the next like/ambient action).
 *
 * Returns the chosen tab id, or null when there is no X tab at all.
 */
export function chooseActuatorTab(tabs: TabRef[], pinnedId?: number | null): number | null {
  if (pinnedId != null && tabs.some((t) => t.id === pinnedId)) return pinnedId;
  const feed = tabs.find((t) => t.id != null && isFeedUrl(t.url));
  if (feed?.id != null) return feed.id;
  return tabs.find((t) => t.id != null)?.id ?? null;
}

/**
 * True if a full URL is the X home timeline. Matches x.com (or twitter.com)
 * with pathname "/", "/home" (plus subpaths), or the "/i/timeline" surface.
 * Anything else — /status/ permalinks, profiles, /notifications, /search —
 * is not a feed the like scan should run on.
 */
export function isHomeUrl(url: string | null | undefined): boolean {
  if (!url) return false;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (!/(^|\.)(x|twitter)\.com$/i.test(u.hostname)) return false;
  return (
    u.pathname === "/" ||
    u.pathname === "/home" ||
    u.pathname.startsWith("/home/") ||
    u.pathname.startsWith("/i/timeline")
  );
}
