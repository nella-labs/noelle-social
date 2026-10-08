// Single source of truth for "is this a Reddit feed?" and "which tab should the
// run drive?". Shared by the background feed-guard (ensureOnFeed + tab
// selection), so the definition of "on a feed" never drifts between call sites.
//
// Why this matters: idle-upvotes and the idle ambient browse must happen on a
// FEED (home / r/all / r/popular). Every path that leaves the tab elsewhere — a
// scheduled reply parking it on the thread's permalink, a mis-landed click
// opening a permalink or /user profile, or the operator opening their own reddit
// tabs — otherwise strands the loop on a page where findFeedUpvoteTarget still
// matches the odd shreddit-post card (a /user profile, a permalink) and the
// "idle" activity silently acts on the wrong surface.

/**
 * Feed pathnames. The allowlist is deliberately aligned with ambient.ts
 * (FEED = "/" and NAV_TARGETS = /r/all/, /r/popular/) plus the home-sort
 * variants (/best /hot /new /top /rising) Reddit serves the home feed under —
 * too narrow and the guard would churn (re-navigating away from the /r/popular
 * the ambient decoy itself just navigated to), too wide (permalinks, /user
 * pages) and the guard is a no-op. Explicitly NOT matched: /r/<sub>/comments/…
 * (a thread permalink) and /user/<name> (a profile).
 */
const FEED_PATH_RE = /^\/(?:best|hot|new|top|rising|r\/(?:all|popular))?(?:\/|$|\?|#)/i;

/** Hosts the actuator drives (see manifest host permissions + findRedditTab). */
const FEED_HOST_RE = /^(?:www\.|old\.)?reddit\.com$/i;

/**
 * True if a full URL is a Reddit feed (home, a home sort, /r/all or /r/popular)
 * on www/bare/old reddit.com. Anything unparseable is not a feed.
 */
export function isFeedUrl(url: string | null | undefined): boolean {
  if (!url) return false;
  try {
    const u = new URL(url);
    return FEED_HOST_RE.test(u.hostname) && isFeedPath(u.pathname);
  } catch {
    return false;
  }
}

/**
 * True if a `location.pathname` is on a feed. Accepts "/", the home sorts
 * ("/best", "/hot", …) and "/r/all…" / "/r/popular…" (any sort suffix).
 */
export function isFeedPath(pathname: string | null | undefined): boolean {
  if (!pathname) return false;
  return FEED_PATH_RE.test(pathname);
}

/** Minimal shape of a chrome.tabs.Tab for tab selection (id + url). */
export interface TabRef {
  id?: number;
  url?: string;
}

/**
 * Pick which reddit tab a run should actuate, given every open reddit.com tab
 * and the tab (if any) already pinned to this run:
 *
 *  1. If a tab was pinned for the run and it is still open, KEEP it — the loop
 *     must not hop tabs mid-run just because another reddit tab now sorts first
 *     (that is how an operator's own permalink/profile tab could hijack the
 *     run). A pinned tab that has wandered off the feed stays chosen; the feed
 *     guard pulls that same tab back to the feed.
 *  2. Otherwise prefer a tab actually ON a feed — never a stray permalink or
 *     /user tab that merely sorts first.
 *  3. Otherwise fall back to the first reddit tab (may be off-feed; the feed
 *     guard will pull it back on the next idle action).
 *
 * Returns the chosen tab id, or null when there is no reddit tab at all.
 */
export function chooseActuatorTab(tabs: TabRef[], pinnedId?: number | null): number | null {
  if (pinnedId != null && tabs.some((t) => t.id === pinnedId)) return pinnedId;
  const feed = tabs.find((t) => t.id != null && isFeedUrl(t.url));
  if (feed?.id != null) return feed.id;
  return tabs.find((t) => t.id != null)?.id ?? null;
}
