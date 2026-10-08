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
  return (box.textContent ?? "").replace(/[\u200B\uFEFF]/g, "").trim();
}

// ── Reply submit ────────────────────────────────────────────────────────────
// Ported from the LinkedIn actuator's composer-anchored submit search (#406/
// #407/#442). The bare testid pair alone is a single point of failure: one
// testid rename = a silent wall of `reply-failed` with zero diagnostics, and
// the old shape happily returned a DISABLED tweetButton (X keeps it disabled
// until the editor model registers text, so clicking it is a silent no-op
// phantom). The search is fail-safe: if nothing qualifies we return null,
// which keeps the background's poll waiting (correct for a submit that is
// disabled until typing registers) and ends in a diagnosable submit-not-found
// instead of a wrong click.

const SUBMIT_WORD = /^(reply|post)$/i;
const isSubmitWord = (s: string) => SUBMIT_WORD.test(s.trim());

/** Exact-word match on aria-label OR text — the real submit shows the word
 * itself ("Reply" / "Post"); action-bar icons show a count (or nothing). */
function submitWordy(el: HTMLElement): boolean {
  return isSubmitWord(el.getAttribute("aria-label") ?? "") || isSubmitWord(el.textContent ?? "");
}

// The DM drawer (bottom-right messages pane) persists across navigations and
// holds its own composer + a type=submit-shaped Send button. X DMs are
// contractually MANUAL-ONLY (see content/index.ts): a reply typed or
// "submitted" there would go out as a PRIVATE MESSAGE, so the box search
// (findReplyBox's dmComposerTextInput exclusion) AND every submit candidate
// reject anything inside it.
export const DM_SEL =
  "[data-testid='DMDrawer'], [data-testid='dmComposerTextInput'], [data-testid='dmComposerSendButton']";

// The left-nav compose affordance opens the NEW-POST modal — wordy ("Post")
// but never the reply submit. It precedes <main> in document order, so the
// FOLLOWING check already excludes it; the testid exclusion is a cheap second
// lock in case X reorders the shell.
const NAV_COMPOSE_SEL = "[data-testid='SideNav_NewTweet_Button'], a[href='/compose/post']";

/** The action-bar reply ICON (opens the composer, never posts). Discriminated
 * by its testid plus a hook-independent SHAPE rule: a button that is wordy
 * only via aria-label while its visible text is empty or just a count ("12",
 * "1.2K") is the per-tweet affordance — the real submit shows the word itself. */
function replyToggleLike(el: HTMLElement): boolean {
  if (el.getAttribute("data-testid") === "reply") return true;
  if (el.closest("[data-testid='reply']") !== null) return true;
  const ownText = (el.textContent ?? "").trim();
  return (ownText === "" || /^\d[\d,.]*[kKmM]?$/.test(ownText)) && isSubmitWord(el.getAttribute("aria-label") ?? "");
}

function submitDisabled(el: HTMLElement): boolean {
  // `.disabled` only exists on real <button>s; aria-disabled covers role=button.
  return (el as HTMLButtonElement).disabled === true || el.getAttribute("aria-disabled") === "true";
}

export interface ReplySubmitHit {
  el: HTMLElement;
  /** Which pass found it (testid:<tid> | composer:<hops>) — rides
   * locateCommentSubmit's observed.via into the failure diagnostics. */
  via: string;
}

export function findReplySubmitInfo(root: ParentNode): ReplySubmitHit | null {
  // 1) Testid fast path, ENABLED only. LIVE-TUNE: 'tweetButtonInline' is the
  //    inline composer's button (timeline / thread pages); 'tweetButton' is the
  //    modal composer's. A disabled hit returns null — the caller's poll waits
  //    for the editor model to register text and enable it; widening toward
  //    decoys is never the right move (#407: clicking a disabled submit is a
  //    silent no-op phantom).
  for (const tid of ["tweetButtonInline", "tweetButton"] as const) {
    const el = root.querySelector<HTMLElement>(`button[data-testid='${tid}']`);
    if (!el || el.closest(DM_SEL) !== null) continue;
    if (submitDisabled(el)) return null;
    return { el, via: `testid:${tid}` };
  }

  // 2) Composer-anchored fallback (#442): climb from the reply box up to 6
  //    ancestors and take the FIRST level that yields a candidate. A candidate
  //    must FOLLOW the box in document order (the submit renders after the
  //    editor; the action-bar reply icon and the left-nav compose button
  //    precede it — position outlives testid/label drift) and be either WORDY
  //    (exact "Reply"/"Post") or an explicit type=submit whose accessible name
  //    isn't a DIFFERENT action ('Send'/'Message'/… must never be clicked by
  //    the reply flow — the DM Send especially). Never widen past a hit; a
  //    level holding only a DISABLED would-be submit returns null (wait for
  //    enable). Candidates inside a tweet article are per-tweet affordances,
  //    never the composer's submit.
  const box = findReplyBox(root);
  if (!box) return null;
  const follows = (el: HTMLElement) =>
    (box.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
  const NONREPLY = /\b(send|message|dm|follow|subscribe|share|repost|retweet|like|bookmark|grok|schedule|draft)\b/i;
  const replySubmitTyped = (el: HTMLElement) => {
    if (el.getAttribute("type") !== "submit") return false;
    const name = `${el.getAttribute("aria-label") ?? ""} ${el.textContent ?? ""}`;
    return !NONREPLY.test(name);
  };
  const wanted = (el: HTMLElement) =>
    (submitWordy(el) || replySubmitTyped(el)) && follows(el) && !replyToggleLike(el) &&
    el.closest(DM_SEL) === null && el.closest(NAV_COMPOSE_SEL) === null &&
    el.closest("article[data-testid='tweet']") === null;
  let scope: HTMLElement | null = box.parentElement;
  for (let hops = 1; scope && hops <= 6; hops++) {
    const wouldBe = Array.from(scope.querySelectorAll<HTMLElement>("button, [role='button']")).filter(wanted);
    const enabled = wouldBe.filter((el) => !submitDisabled(el));
    if (enabled.length > 0) {
      // Prefer worded, then explicit type=submit; querySelectorAll order keeps
      // first-in-document among equals.
      const score = (el: HTMLElement) =>
        (submitWordy(el) ? 4 : 0) + (el.getAttribute("type") === "submit" ? 2 : 0);
      const best = enabled.reduce((a, b) => (score(b) > score(a) ? b : a));
      return { el: best, via: `composer:${hops}` };
    }
    if (wouldBe.length > 0) return null; // disabled submit at this level: wait, never widen
    if (scope.tagName === "FORM") break;
    scope = scope.parentElement;
  }
  return null;
}

/** The reply submit, or null. Kept as the simple-shape accessor; the info
 * variant carries the `via` pass for diagnostics. */
export function findReplySubmit(root: ParentNode): HTMLElement | null {
  // Delegates to the info variant, which preserves the disabled→null guard
  // (a disabled tweetButton is a phantom submit) and the DM-drawer exclusion.
  return findReplySubmitInfo(root)?.el ?? null;
}

/**
 * True when the opened permalink is a dead reply target: the tweet was deleted
 * ("This post was deleted by the post author."), the author protects their
 * posts ("These posts are protected."), the account is gone, or the route 404s
 * ("Hmm...this page doesn't exist."). No composer will ever render for this
 * account, so the actuator DROPS the draft (and marks it skipped server-side)
 * instead of retrying the dead permalink on every slot.
 *
 * A positive here feeds a DURABLE server write (markSkipped flips a valid
 * pending approval to status='skipped'), so the signal is structurally gated —
 * whole-document phrase matching alone false-positives on healthy pages:
 *   1. `[data-testid='error-detail']` (X's dedicated error/interstitial
 *      container) is trusted unconditionally — it never renders on a healthy
 *      permalink.
 *   2. The phrase probe is trusted ONLY when NO `article[data-testid='tweet']`
 *      exists on the page. A rendered tweet article means the target is alive:
 *      the exact interstitial phrase also appears inside embedded quote cards
 *      of deleted tweets (an everyday repliable target) and in ordinary reply
 *      prose ("this tweet has been deleted"), both of which render tweet
 *      articles — X's dead-target interstitial never does.
 * A false NEGATIVE here is safe: the composer locate fails, the draft retries
 * under the MAX_ACTION_TRIES cap, and no durable write fires.
 * LIVE-TUNE: English-only phrases, like isPromoted.
 */
export function isPostUnavailable(root: ParentNode): boolean {
  // Structural signal: X's error/interstitial container. Trusted as-is.
  if (root.querySelector("[data-testid='error-detail']") !== null) return true;
  // Any rendered tweet article ⇒ the page has live content; a phrase hit would
  // be a quote-card tombstone or prose, NOT the dead-target interstitial.
  if (root.querySelector("article[data-testid='tweet']") !== null) return false;
  const el = root instanceof Element ? root : (root as Document).body ?? null;
  const text = (el?.textContent ?? "").replace(/\s+/g, " ");
  // ['’]? — X renders typographic apostrophes ("doesn’t"), match both.
  return [
    /this (?:post|tweet) was deleted by the (?:post|tweet) author/i,
    /these posts are protected/i,
    /this (?:post|tweet) (?:is )?unavailable/i,
    /this account doesn['’]?t exist/i,
    /this page doesn['’]?t exist/i,
    /account suspended/i,
  ].some((re) => re.test(text));
}

/**
 * The reply icon in a tweet's action bar, or null. Ambient (read-only) decoy
 * affordance: a human scrolling the feed regularly opens the discussion under a
 * tweet. On X this opens the reply composer (a modal on the timeline) rather
 * than merely expanding a thread — the loop only reads and dismisses, never
 * types. LIVE-TUNE: button[data-testid='reply']; restricted-reply tweets keep
 * the icon but disable it, and a disabled icon is not a usable affordance.
 */
export function findReplyAffordance(tweet: Element): HTMLElement | null {
  const btn = tweet.querySelector<HTMLElement>("button[data-testid='reply']");
  if (!btn) return null;
  if (btn.hasAttribute("disabled") || btn.getAttribute("aria-disabled") === "true") return null;
  return btn;
}

/** True if the tweet exposes a usable reply affordance. */
export function hasReplies(tweet: Element): boolean {
  return findReplyAffordance(tweet) !== null;
}

/**
 * Returns the long-tweet "Show more" expander, or null. LIVE-TUNE: testid
 * first; the text fallback is anchored so "Show more replies" never matches.
 */
export function findSeeMore(tweet: Element): HTMLElement | null {
  const primary = tweet.querySelector<HTMLElement>("[data-testid='tweet-text-show-more-link']");
  if (primary) return primary;

  // Fallback: exact text match on link/button-shaped elements inside the tweet.
  for (const el of Array.from(tweet.querySelectorAll<HTMLElement>("a, button, [role='link'], [role='button']"))) {
