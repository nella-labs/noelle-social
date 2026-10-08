// Single source of truth for "is this the LinkedIn feed?" and "which tab should
// the run drive?". Shared by the background feed-guard (ensureOnFeed + tab
// selection) and the content-script ambient locator gate, so the definition of
// "on the feed" never drifts between the two layers.
//
// Why this matters: feed-liking and the idle ambient browse must happen on the
// /feed/. Every path that leaves the tab elsewhere — doDm/doComment parking it on
// a profile/permalink, a stale-rect click SPA-navigating onto a profile, or the
// operator opening their own linkedin tabs — otherwise strands the loop on a
// profile page, where it finds no fresh feed posts and the like counter freezes.

/**
 * True if a full URL is the LinkedIn feed (home). Matches
 * https://www.linkedin.com/feed followed by "/", end-of-string, "?" or "#".
 * Kept equivalent to (a superset of) the original in-line like-path guard
 * `/linkedin\.com\/feed(\/|$|\?)/` so extracting it changes no behavior there.
 */
export function isFeedUrl(url: string | null | undefined): boolean {
  if (!url) return false;
  return /linkedin\.com\/feed(\/|$|\?|#)/i.test(url);
}

/**
 * True ONLY for the LinkedIn HOME feed — https://www.linkedin.com/feed(/) with
 * nothing after it but "?"/"#"/end — and NOT a post permalink like
 * /feed/update/urn:li:activity|groupPost:… .
 *
 * `isFeedUrl` above is deliberately PERMISSIVE — a permalink counts as
 * "feed-ish" so chooseActuatorTab never abandons a run whose pinned tab opened a
 * post. But the feed-guard (ensureOnFeed) needs the STRICT question — "is this
 * tab on the ACTUAL home feed, where feed-likes work?". A group-post permalink
 * renders a single post whose like button often isn't where the feed scanner
 * looks, so treating it as "on feed" made the run whiff
 * `no-likeable-post(...path=/feed/update/urn:li:groupPost:…)` on repeat instead
 * of navigating home. ensureOnFeed uses THIS, so it pulls back to /feed/ first.
 */
export function isHomeFeedUrl(url: string | null | undefined): boolean {
  if (!url) return false;
  return /linkedin\.com\/feed\/?(\?|#|$)/i.test(url);
}

/**
 * True if a `location.pathname` is on the feed. Accepts "/feed" and "/feed/…".
 * Used by the content locators (which only see the pathname, not the full URL).
 */
export function isFeedPath(pathname: string | null | undefined): boolean {
  if (!pathname) return false;
  return /^\/feed(\/|$|\?|#)/i.test(pathname);
}

/** Minimal shape of a chrome.tabs.Tab for tab selection (id + url). */
export interface TabRef {
  id?: number;
  url?: string;
}

/**
 * Pick which LinkedIn tab a run should actuate, given every open linkedin.com
 * tab and the tab (if any) already pinned to this run:
 *
 *  1. If a tab was pinned for the run and it is still open, KEEP it — the loop
 *     must not hop tabs mid-run just because another linkedin tab now sorts
 *     first (that is how an operator's own profile tab used to hijack the run).
 *     A pinned tab that has wandered off the feed stays chosen; the feed guard
 *     pulls that same tab back to /feed/.
 *  2. Otherwise prefer a tab actually ON the feed — never a stray /in/ profile
 *     tab that merely sorts first.
 *  3. Otherwise fall back to the first linkedin tab (may be off-feed; the feed
 *     guard will pull it back on the next like/ambient action).
 *
 * Returns the chosen tab id, or null when there is no linkedin tab at all.
 */
export function chooseActuatorTab(tabs: TabRef[], pinnedId?: number | null): number | null {
  if (pinnedId != null && tabs.some((t) => t.id === pinnedId)) return pinnedId;
  const feed = tabs.find((t) => t.id != null && isFeedUrl(t.url));
  if (feed?.id != null) return feed.id;
  return tabs.find((t) => t.id != null)?.id ?? null;
}
