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
