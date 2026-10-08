// LIVE-TUNE: x.com DOM selectors. Verified against x.com's data-testid API as of
// build time but MUST be confirmed against a live logged-in x.com tab before
// lights-out use (see docs/x-actuator-plan.md). data-testid values are the most
// stable x.com hooks; class names are not used.

/**
 * All rendered timeline tweets. LIVE-TUNE: article[data-testid='tweet'] covers
 * the home timeline, profile, search, and thread pages. X virtualizes the list,
 * so only the ~10-20 tweets near the viewport exist in the DOM at any moment.
 *
 * Drift-resistant fallback: when the article selector misses entirely (X does
 * rename the wrapper element/testid occasionally, even if less often than
 * LinkedIn renames classes), derive tweets from their like buttons instead —
 * each like/unlike button ⇒ climb to the tweet-sized container that wraps
 * exactly it. Fully element-/testid-agnostic for the CONTAINER, so standalone
 * feed-likes survive wrapper churn; downstream isPromoted / tweetId /
 * tweetAuthorHandle query within the returned container and keep working.
 * Fires only when the article selector returns 0, so normal behavior is
 * unchanged.
 */
export function findFeedTweets(root: ParentNode): Element[] {
  const direct = Array.from(root.querySelectorAll("article[data-testid='tweet']"));
  if (direct.length > 0) return direct;
  const rootEl = root instanceof Element ? root : null;
  const out = new Set<Element>();
  for (const btn of findLikeButtons(root)) {
    const tweet = tweetContainerOf(btn, rootEl);
    if (tweet) out.add(tweet);
  }
  return Array.from(out);
}

/** Like-affordance selectors: the unliked action first ("like"), then the
 * already-liked state ("unlike" — the same button, testid swapped). Shared by
 * findLikeButton / isAlreadyLiked and the findFeedTweets fallback so the
 * "which button is a like" definition never drifts between them. */
export const LIKE_BUTTON_SELECTORS = [
  "button[data-testid='like']",
  "button[data-testid='unlike']",
] as const;

/** Every like/unlike button under root (order-preserving, deduped). */
export function findLikeButtons(root: ParentNode): Element[] {
  const seen = new Set<Element>();
  for (const sel of LIKE_BUTTON_SELECTORS) {
    for (const el of Array.from(root.querySelectorAll(sel))) seen.add(el);
  }
  return Array.from(seen);
}

/**
 * The tweet-sized container that wraps a single like affordance: the LARGEST
 * ancestor that still contains exactly this one like/unlike button (its parent
 * would also wrap the next tweet's). Lands on the timeline cell even when the
 * <article data-testid='tweet'> wrapper has churned.
 */
function tweetContainerOf(btn: Element, rootEl: Element | null): Element | null {
  let node: Element | null = btn.parentElement;
  let best: Element | null = null;
  while (node && node !== rootEl) {
    if (findLikeButtons(node).length === 1) best = node;
    else break; // parent now wraps a second tweet → stop at the previous ancestor
    node = node.parentElement;
  }
  return best;
}

/**
 * The tweet's canonical permalink href ("/{handle}/status/{id}"), or null.
 * LIVE-TUNE: the timestamp <time> is wrapped by the permalink anchor. Quote
 * tweets nest additional /status/ links, so the <time> route is preferred and
 * the bare first-anchor match is only a fallback.
 */
function permalink(tweet: Element): string | null {
  const viaTime = tweet.querySelector("time")?.closest("a[href*='/status/']")?.getAttribute("href");
  if (viaTime) return viaTime;
  return tweet.querySelector("a[href*='/status/']")?.getAttribute("href") ?? null;
}

/**
 * The tweet's numeric status id parsed from its permalink, or null. (The x.com
 * analog of LinkedIn's activity URN.)
 */
export function tweetId(tweet: Element): string | null {
  const href = permalink(tweet);
  if (!href) return null;
  return /\/status\/(\d+)/.exec(href)?.[1] ?? null;
}

/**
 * True for ads. Current X also puts placementTracking on ordinary feed posts,
 * so it is not an ad signal. The visible "Ad" / "Promoted" label rides the
 * header or social-context line; never treat words inside the post body as a
 * platform label.
 */
export function isPromoted(tweet: Element): boolean {
  const ctx = tweet.querySelector("[data-testid='socialContext']");
  if (ctx && /\bPromoted\b|\bAd\b/.test(ctx.textContent ?? "")) return true;
  // Fallback: a standalone "Ad" / "Promoted" label span (X A/B-tests where the label lands).
  for (const span of Array.from(tweet.querySelectorAll("span"))) {
    if (span.closest("[data-testid='tweetText']")) continue;
    const t = (span.textContent ?? "").trim();
    if (t === "Ad" || t === "Promoted") return true;
  }
  return false;
}

/**
 * The like action, or null when absent OR already liked — the liked state swaps
 * the testid to "unlike", so this selector naturally misses liked tweets.
 * LIVE-TUNE: button[data-testid='like'] in the tweet's action bar (quoted
 * tweets render without an action bar, so no nested ambiguity).
 */
export function findLikeButton(tweet: Element): HTMLElement | null {
  return tweet.querySelector<HTMLElement>(LIKE_BUTTON_SELECTORS[0]);
}

/** LIVE-TUNE: liked tweets carry button[data-testid='unlike']. */
export function isAlreadyLiked(tweet: Element): boolean {
  return tweet.querySelector(LIKE_BUTTON_SELECTORS[1]) !== null;
}

/**
 * The bookmark action in a tweet's action bar, or null when absent OR already
 * bookmarked — the bookmarked state swaps the testid to 'removeBookmark', so
 * this selector naturally misses tweets already saved. LIVE-TUNE:
 * button[data-testid='bookmark'].
 */
export function findBookmarkButton(tweet: Element): HTMLElement | null {
  return tweet.querySelector<HTMLElement>("button[data-testid='bookmark']");
}

/**
 * The repost (retweet) action in a tweet's action bar, or null when absent OR
 * already reposted — the reposted state swaps the testid to 'unretweet'. Clicking
 * it opens the repost confirm menu (see findRetweetConfirm). LIVE-TUNE:
 * button[data-testid='retweet'].
 */
export function findRetweetButton(tweet: Element): HTMLElement | null {
  return tweet.querySelector<HTMLElement>("button[data-testid='retweet']");
}

/**
 * The "Repost" confirm item inside the transient menu X opens after the retweet
 * button is clicked, or null when the menu isn't showing. Resolution order,
 * most- to least- drift-resistant:
 *   1. [data-testid='retweetConfirm'] — the stable menu-item hook.
 *   2. a menuitem whose exact text is "Repost" (never "Quote", so a label match
 *      can't pick the quote-tweet path instead). Scoped to the open menu.
 * Searched from the document root (the menu portals outside the tweet). The
 * caller must NOT scrollIntoView this — a scroll dismisses the menu.
 */
export function findRetweetConfirm(root: ParentNode): HTMLElement | null {
  const byData = root.querySelector<HTMLElement>("[data-testid='retweetConfirm']");
  if (byData) return byData;
  const menu = root.querySelector<HTMLElement>("[role='menu']");
  if (menu) {
    for (const item of Array.from(menu.querySelectorAll<HTMLElement>("[role='menuitem']"))) {
      if (/^\s*Repost\s*$/i.test(item.textContent ?? "")) return item;
    }
  }
  return null;
}

/**
 * The reply composer textbox ("comment box" in actuator-protocol speak — on X
 * this is a reply). LIVE-TUNE: [data-testid='tweetTextarea_0'] is the DraftJS
 * editor root; depending on build the testid sits on the contenteditable itself
 * or on a wrapper above it, so descend when needed. The "_0" suffix is the
 * page's first composer (thread-compose adds _1, _2, …).
 */
export function findReplyBox(root: ParentNode): HTMLElement | null {
  const ta = root.querySelector<HTMLElement>("[data-testid='tweetTextarea_0']");
  if (ta) {
    if (ta.getAttribute("contenteditable") === "true") return ta;
    return ta.querySelector<HTMLElement>("[contenteditable='true'], [role='textbox']") ?? ta;
  }
  // Fallbacks: any tweet-composer textbox, then any contenteditable textbox —
  // but never the DM composer (X DMs stay manual; no DM selectors in this file).
  return (
    root.querySelector<HTMLElement>("div[role='textbox'][contenteditable='true'][data-testid^='tweetTextarea']") ??
    root.querySelector<HTMLElement>("div[role='textbox'][contenteditable='true']:not([data-testid='dmComposerTextInput'])")
  );
}

/**
 * The current text inside the reply composer, trimmed (zero-width chars the
 * DraftJS editor leaves are stripped). Returns null when there is no composer
 * at all. The background reads this after a submit to CONFIRM the reply landed:
 * X clears the composer (inline) or unmounts it (modal) on a successful post,
 * so a still-populated box means the reply did NOT go through (an off-viewport
 * button the click missed, or a submit that never fired). The DraftJS
 * placeholder ("Post your reply") lives outside the contenteditable, so an
 * empty composer reads as "".
 */
export function replyBoxText(root: ParentNode): string | null {
  const box = findReplyBox(root);
  if (!box) return null;
  // Strip zero-width space / BOM the rich editor can leave behind, so an
  // otherwise-cleared box reads as empty.
