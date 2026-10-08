// LIVE-TUNE: x.com notifications-page + thread-page scraping for the
// notifications actor ("Auto notifications"). Pure functions over a DOM root,
// so every rule below is unit-tested against fixtures instead of a live tab.
//
// Kept out of selectors.ts on purpose — that file is already the feed/composer
// surface and long enough. This is the conversation surface.

import { findFeedTweets, isPromoted, tweetAuthorHandle, tweetId, tweetText } from "./selectors.js";

/** One harvested notification cell (a tweet rendered in the mentions timeline). */
export interface HarvestedNotification {
  tweet_id: string;
  /** Author handle, @-stripped. */
  handle: string;
  text: string;
  /** Absolute permalink to THEIR tweet — what the actuator opens to reply. */
  url: string;
  /** The tweet's own timestamp (ISO), from <time datetime>. Null when absent. */
  posted_at: string | null;
  /**
   * Handles named in the cell's "Replying to @a @b" context line, @-stripped
   * and lowercased. Empty when the cell is not a reply — which is how a bare
   * mention or a quote post is told apart from a reply to us.
   */
  replying_to: string[];
}

/** One tweet in a thread page's ancestor chain. */
export interface ThreadTweet {
  tweet_id: string;
  handle: string;
  text: string;
}

const REPLYING_TO = /^replying to\b/i;
const HANDLE = /@([A-Za-z0-9_]{1,15})/g;

export function stripAt(handle: string): string {
  return handle.trim().replace(/^@/, "").toLowerCase();
}

/**
 * The handles a cell says it is replying to, @-stripped + lowercased.
 *
 * LIVE-TUNE: X renders the reply context as a small block whose text reads
 * "Replying to @alice @bob". It carries no stable testid, so this matches the
 * leading phrase on any element whose OWN text starts with it, then reads the
 * @handles out of that text. Scoped to elements that are not the tweet body
 * (the body is [data-testid='tweetText']) so a tweet literally beginning with
 * the words "Replying to @x" can't fake a reply context.
 */
export function replyContextHandles(tweet: Element): string[] {
  for (const el of Array.from(tweet.querySelectorAll<HTMLElement>("div, span"))) {
    if (el.closest("[data-testid='tweetText']")) continue; // never trust the body
    const text = (el.textContent ?? "").trim();
    if (!REPLYING_TO.test(text)) continue;
    // Take the SHORTEST matching element: ancestors of the real context line
    // also start with the phrase, and their text drags in the tweet body.
    const inner = Array.from(el.querySelectorAll<HTMLElement>("div, span")).find((child) =>
      REPLYING_TO.test((child.textContent ?? "").trim()),
    );
    const source = inner ? (inner.textContent ?? "") : text;
    const out = new Set<string>();
    for (const m of source.matchAll(HANDLE)) out.add(m[1]!.toLowerCase());
    if (out.size > 0) return Array.from(out);
  }
  return [];
}

/** The tweet's own timestamp (ISO) from its <time datetime>, or null. */
export function tweetPostedAt(tweet: Element): string | null {
  const dt = tweet.querySelector("time")?.getAttribute("datetime");
  return dt && dt.trim() ? dt.trim() : null;
}

/**
 * Only notifications from the last 12 hours are eligible.
 *
 * The seen-ring alone answers the wrong question. It is per-install and starts
 * empty, so a fresh profile's first sweep happily answers whatever is oldest on
 * the page — and X keeps days of notifications there. Replying to a two-day-old
 * comment is necro-engagement: the thread has moved on and the answer reads as
 * a bot working through a backlog. Twelve hours keeps us to live conversations.
 */
export const MAX_AGE_MINUTES = 720;

/** Age of an ISO timestamp in minutes. null when absent or unparseable. */
export function ageMinutes(postedAt: string | null | undefined, nowMs: number): number | null {
  if (!postedAt) return null;
  const t = Date.parse(postedAt);
  if (!Number.isFinite(t)) return null;
  return (nowMs - t) / 60_000;
}

/**
 * Is this inside the window?
 *
 * An item whose age cannot be read is OUT: we cannot prove it is recent, and
 * only provably-recent things get answered. A cell timestamped slightly in the
 * future (clock skew) is negative-age and still counts as recent.
 */
export function withinAgeWindow(
  postedAt: string | null | undefined,
  opts: { nowMs: number; maxAgeMinutes: number },
): boolean {
  const age = ageMinutes(postedAt, opts.nowMs);
  return age !== null && age <= opts.maxAgeMinutes;
}

/**
 * How the harvested cells fall against the window, for the sweep's telemetry.
 *
 * `undated` is the operationally important one: if X changes its <time> markup
 * this jumps to "all of them", the actor answers nothing, and the sweep line
 * says exactly that instead of reporting a quiet empty inbox.
 */
export function ageBuckets(
  items: readonly HarvestedNotification[],
  opts: { nowMs: number; maxAgeMinutes: number },
): { recent: number; stale: number; undated: number } {
  let recent = 0;
  let stale = 0;
  let undated = 0;
  for (const item of items) {
    const age = ageMinutes(item.posted_at, opts.nowMs);
    if (age === null) undated++;
    else if (age <= opts.maxAgeMinutes) recent++;
    else stale++;
  }
  return { recent, stale, undated };
}

/**
 * Every tweet cell rendered on the notifications page, as harvest records.
 * Promoted cells and cells missing an id/handle/body are dropped here; the
 * "is this actually a reply to ME" decision is `selectRepliesToMe`, so the
 * scraping and the policy stay separately testable.
 */
export function harvestNotifications(root: ParentNode): HarvestedNotification[] {
  const out: HarvestedNotification[] = [];
  for (const cell of findFeedTweets(root)) {
    if (isPromoted(cell)) continue;
    const id = tweetId(cell);
    const handle = tweetAuthorHandle(cell);
    const text = tweetText(cell);
    if (!id || !handle || !text) continue;
    out.push({
      tweet_id: id,
      handle,
      text,
      url: `https://x.com/${handle}/status/${id}`,
      posted_at: tweetPostedAt(cell),
      replying_to: replyContextHandles(cell),
    });
  }
  return out;
}

/**
 * The replies-to-me worth enqueueing, newest-first order preserved.
 *
 * Five gates, all of them cheap and all of them necessary:
 *  - authored by someone else (never answer ourselves — that IS the ping-pong),
 *  - the cell's reply context names us (a bare @mention or a quote post is not
 *    a reply to us; This feature is scoped to replies only),
 *  - posted inside the recency window (see MAX_AGE_MINUTES),
 *  - not already seen this install (the local ring; the server's external_id
 *    unique constraint is the real backstop),
 *  - bounded per sweep, so one busy morning can't dump 40 leads into drafting.
 */
export function selectRepliesToMe(
  items: HarvestedNotification[],
  opts: {
    selfHandle: string;
    seen: readonly string[];
    max: number;
    nowMs?: number;
    maxAgeMinutes?: number;
  },
): HarvestedNotification[] {
  const nowMs = opts.nowMs ?? Date.now();
  const maxAgeMinutes = opts.maxAgeMinutes ?? MAX_AGE_MINUTES;
  const seen = new Set(opts.seen);
  const out: HarvestedNotification[] = [];
  for (const item of items) {
    if (out.length >= opts.max) break;
    if (!isReplyToMe(item, opts.selfHandle)) continue;
    if (!withinAgeWindow(item.posted_at, { nowMs, maxAgeMinutes })) continue;
    if (seen.has(item.tweet_id)) continue;
    out.push(item);
  }
  return out;
}

/**
 * Is this cell somebody ELSE replying to US? The identity gates only — no
 * recency, no seen-ring.
 *
 * This is the "was it ever a candidate" question, and it has to be answerable
 * on its own because the notifications page is mostly things that are not
 * replies to us: likes, follows, our own tweets. Describing a sweep's outcome
 * in terms of every harvested cell would attribute a zero to the recency window
 * when the real reason is that nobody replied to us at all.
 */
export function isReplyToMe(
  item: Pick<HarvestedNotification, "handle" | "replying_to">,
  selfHandle: string,
): boolean {
  const me = stripAt(selfHandle);
  if (!me) return false;
  if (stripAt(item.handle) === me) return false; // never answer ourselves
  return item.replying_to.includes(me);
}

/**
 * The operator's own @handle, read from the logged-in chrome.
 *
 * LIVE-TUNE: the sidebar account switcher renders "Display Name @handle" and is
 * the one element on every page guaranteed to name the logged-in account. The
 * "Profile" nav link (/{handle}) is the fallback for the narrow layout, where
 * the switcher collapses to an avatar with no text.
 */
export function readSelfHandle(root: ParentNode): string | null {
  // The account switcher renders "Display Name @handle" and is present on every
  // logged-in page. Checked first because it is unambiguous.
  const switcher = root.querySelector("[data-testid='SideNav_AccountSwitcher_Button']");
  if (switcher) {
    for (const span of Array.from(switcher.querySelectorAll("span"))) {
      const t = (span.textContent ?? "").trim();
      if (t.startsWith("@") && t.length > 1) return stripAt(t);
    }
  }
  // The profile nav link, whose href IS the handle. Two testids because X ships
  // a different one on the narrow layout, where the switcher collapses to a
  // bare avatar with no text.
  for (const sel of ["[data-testid='AppTabBar_Profile_Link']", "a[aria-label='Profile'][href^='/']"]) {
    const href = root.querySelector(sel)?.getAttribute("href") ?? "";
    const m = /^\/([A-Za-z0-9_]{1,15})$/.exec(href);
    if (m) return m[1]!.toLowerCase();
  }
  // Deliberately NO frequency-based guess as a last resort: a WRONG self handle
  // would silently harvest the wrong conversations (every reply aimed at
  // someone else), which is far worse than harvesting none. When both reads
  // fail the caller falls back to the operator-configured handle and, failing
  // that, says so loudly instead of guessing.
  return null;
}

/**
 * The ancestor chain above a focused tweet on its permalink page, oldest first.
 *
 * X renders a thread page as the ancestors, then the focused tweet, then its
 * replies. Everything before the focused cell in DOM order is the conversation
 * that led to it — which is exactly the context the drafter needs to answer a
 * reply instead of cold-replying to a fragment. Returns [] when the focused
 * tweet isn't on the page (a deleted/protected target).
 */
export function harvestThread(root: ParentNode, focusTweetId: string): ThreadTweet[] {
  const cells = findFeedTweets(root);
  const chain: ThreadTweet[] = [];
  for (const cell of cells) {
    if (isPromoted(cell)) continue; // an ad between cells is not part of the thread
    const id = tweetId(cell);
    // WHERE THE FOCAL TWEET IS. LIVE-TUNE, and the subtle part: X renders the
    // focal tweet's timestamp WITHOUT a self-permalink anchor — you are already
    // on its page — so `tweetId` cannot resolve it (see the header comment in
    // tests/fixtures/status-page.html, captured from the real site). Matching on
    // `id === focusTweetId` therefore NEVER fires on a real thread page, and this
    // function returned [] for every real conversation.
    //
    // So the marker is the ABSENCE of an id, with the explicit id match kept for
    // layouts that do render a self-link. Stopping at an id-less ancestor (a
    // partially-hydrated cell) is the safe failure: a shorter chain, or an empty
    // one the sweep then drops and retries — never a mis-attributed thread.
    if (id === null || id === focusTweetId) return chain;
    const handle = tweetAuthorHandle(cell);
    const text = tweetText(cell);
    if (!handle || !text) continue;
    chain.push({ tweet_id: id, handle, text });
  }
  return []; // focal tweet never appeared → the chain we built isn't trustworthy
}

/**
 * Collapse an ancestor chain into the two turns the drafter actually quotes:
 * the thread's root, and the last thing WE said (what they are answering).
 * Both are optional — a reply to our root post has no separate "our reply".
 */
export function conversationFrom(
  chain: readonly ThreadTweet[],
  selfHandle: string,
): { root_post_id?: string; root_post_text?: string; our_reply_id?: string; our_reply_text?: string } {
  const me = stripAt(selfHandle);
  const out: {
    root_post_id?: string;
    root_post_text?: string;
    our_reply_id?: string;
    our_reply_text?: string;
  } = {};
  const root = chain[0];
  if (root) {
    out.root_post_id = root.tweet_id;
    out.root_post_text = root.text;
  }
  for (let i = chain.length - 1; i >= 0; i--) {
    const t = chain[i]!;
    if (stripAt(t.handle) !== me) continue;
    // The root already carries our text when we are the root author.
    if (root && t.tweet_id === root.tweet_id) break;
    out.our_reply_id = t.tweet_id;
    out.our_reply_text = t.text;
    break;
  }
  return out;
}
