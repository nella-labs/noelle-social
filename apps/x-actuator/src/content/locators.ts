import type { Rng } from "../lib/rng.js";
import {
  findFeedTweets, findLikeButton, findLikeButtons, isAlreadyLiked, isPromoted, tweetId, tweetAuthorHandle,
  findReplyBox as selReplyBox, findReplySubmitInfo as selReplySubmitInfo, findChallenge,
  diagnoseReplySubmit as selDiagnoseReplySubmit, replyBoxText as selReplyBoxText,
  isReplyRestricted as selIsReplyRestricted,
  wordCount as selWordCount, hasMedia as selHasMedia, isTruncated as selIsTruncated,
  findSeeMore as selFindSeeMore, findReplyAffordance as selFindReplyAffordance, hasReplies as selHasReplies,
  findBookmarkButton as selFindBookmark, findRetweetButton as selFindRetweet, findRetweetConfirm as selFindRetweetConfirm,
  isPostUnavailable as selIsPostUnavailable,
} from "./selectors.js";
import type { EngagementKind } from "../lib/engagement.js";

export interface LocateResult {
  ok: boolean;
  x?: number;
  y?: number;
  /**
   * The element's bounding rect (rounded). Carried alongside the center coords
   * so the CDP layer can sample a 2D-Gaussian click point and derive the Fitts
   * target width `W`. Populated after the element is scrolled into view.
   */
  rect?: { x: number; y: number; width: number; height: number };
  observed?: Record<string, unknown>;
  skipReason?: string;
}

export function elementCenter(el: Element): { x: number; y: number } {
  const r = el.getBoundingClientRect();
  return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
}

/** The element's bounding rect, rounded — the Fitts target box for clickPoint. */
export function elementRect(el: Element): { x: number; y: number; width: number; height: number } {
  const r = el.getBoundingClientRect();
  return { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) };
}

/**
 * Author text a watchlist entry can match against: the User-Name block reads
 * "Display Name @handle · 2h", so entries given as either a display name or an
 * @handle both hit. LIVE-TUNE: [data-testid='User-Name'].
 */
function tweetAuthorText(tweet: Element): string | null {
  const block = tweet.querySelector("[data-testid='User-Name']")?.textContent?.trim();
  return block || (tweetAuthorHandle(tweet) ?? null);
}

export function locateLikeTarget(
  root: ParentNode,
  opts: { preferWatchlist: boolean; watchlistNames: string[] },
  rng: Rng,
): LocateResult {
  const all = findFeedTweets(root);
  const withBtn = all.filter((p) => findLikeButton(p));
  const likeable = withBtn.filter((p) => !isPromoted(p) && !isAlreadyLiked(p));
  if (likeable.length === 0) {
    // Diagnostic counts so a skip row in noelle.x_activity says exactly WHY
    // zero tweets were likeable, without a live DevTools session:
    //   btns = like/unlike buttons anywhere on the page (0 ⇒ timeline not
    //          loaded or the testid drifted; >0 with tweets=0 ⇒ the container
    //          fallback should have caught it, so a real oddity)
    //   path = location.pathname (≠ /home ⇒ the tab wasn't on the timeline —
    //          the standalone-like ensureOnHome guard should prevent this)
    const btns = findLikeButtons(root).length;
    const path = (typeof location !== "undefined" && location.pathname) || "?";
    return {
      ok: false,
      skipReason: `no-likeable-tweet(tweets=${all.length},withBtn=${withBtn.length},btns=${btns},path=${path})`,
    };
  }

  // Prefer tweets in/just-below the current viewport so the click lands on a
  // visible tweet (and we don't scroll back up to one already passed).
  const vh = typeof window !== "undefined" ? window.innerHeight || 800 : 800;
  const inView = likeable.filter((p) => {
    const top = p.getBoundingClientRect().top;
    return top > -200 && top < vh * 1.4;
  });
  const tweets = inView.length > 0 ? inView : likeable;

  // Pick a random in-view tweet, not always the topmost — an always-first-tweet
  // like is its own tell (#429 anti-fingerprint). Watchlist preference still wins.
  let pick = tweets[rng.int(0, tweets.length - 1)]!;
  if (opts.preferWatchlist && opts.watchlistNames.length > 0) {
    const wl = tweets.find((p) => {
      const author = tweetAuthorText(p)?.toLowerCase() ?? "";
      return opts.watchlistNames.some((w) => author.includes(w.toLowerCase().replace(/^@/, "")));
    });
    if (wl) pick = wl;
    else if (rng.next() < 0.5) return { ok: false, skipReason: "no-watchlist-tweet" }; // sometimes hold
  }

  // Content hints for the reading model: how long to dwell before reacting,
  // whether to expand "Show more", and where the expander is. Computed on the
  // picked tweet (the one we're about to like). seeMoreRect rides the existing
  // locateLike path so the loop can click it without a new message type.
  const wc = selWordCount(pick);
  const media = selHasMedia(pick);
  const trunc = selIsTruncated(pick);
  const seeMore = trunc ? selFindSeeMore(pick) : null;

  const btn = findLikeButton(pick)!;
  // Scroll FIRST, measure AFTER. The in-view filter admits tweets up to
  // 1.4*viewport below the fold, so this scroll can move the page by hundreds
  // of px — every rect this function returns (the like rect AND seeMoreRect)
  // must be measured in the post-scroll viewport. The background fires a
  // trusted CDP click straight at seeMoreRect (the expand branch), so a
  // pre-scroll measurement would land that click on a different tweet's text,
  // a link, or a Follow button.
  btn.scrollIntoView?.({ block: "center" });
  const seeMoreRect = seeMore ? elementRect(seeMore) : undefined;
  const { x, y } = elementCenter(btn);
  return {
    ok: true, x, y, rect: elementRect(btn),
    observed: {
      tweet_id: tweetId(pick),
      author_handle: tweetAuthorHandle(pick),
      wordCount: wc,
      hasMedia: media,
      isTruncated: trunc,
      ...(seeMoreRect ? { seeMoreRect } : {}),
    },
  };
}

/**
 * Protocol note: "comment" == X reply here. The background worker sends
 * cmd:"locateCommentBox" (the actuator protocol inherited from the LinkedIn
 * actuator), so the name stays even though the target is X's reply composer.
 */
export function locateCommentBox(root: ParentNode): LocateResult {
  // selReplyBox never returns the DM composer (dmComposerTextInput is excluded
  // outright — typing a reply there would deliver it as a private message).
  const box = selReplyBox(root);
  if (!box) return { ok: false, skipReason: "selector-not-found" };
  box.scrollIntoView?.({ block: "center" });
  const rect = elementRect(box);
  // Zero-sized box (hidden/detached) — same corner-click hazard the submit
  // guard below covers: rectFrom would synthesize a 4x4 box at {0,0} and the
  // focus click + typing would land at body focus, not the composer.
  if (rect.width <= 0 || rect.height <= 0) return { ok: false, skipReason: "box-zero-rect" };
  const { x, y } = elementCenter(box);
  return { ok: true, x, y, rect };
}

/**
 * Locate the like button of the tweet just replied to, on the currently-open
 * status page (doComment navigated to it). `targetTweetId` is the id from the
 * reply target's permalink: prefer the <article> whose own permalink matches it;
 * the FOCAL tweet on a status page renders its <time> without a self-permalink
 * anchor (tweetId ⇒ null), so when no article matches by id, the permalink-less
 * article IS the focal one — fall back to it (then to the first article). That
 * keeps the like off a thread ancestor, which does carry a permalink.
 * Skips when the tweet is already liked or exposes no like button.
 */
export function locatePostLike(root: ParentNode, targetTweetId?: string | null): LocateResult {
  const all = findFeedTweets(root);
  if (all.length === 0) return { ok: false, skipReason: "no-tweet" };
  const byId = targetTweetId ? all.find((t) => tweetId(t) === targetTweetId) : undefined;
  const focal = all.find((t) => tweetId(t) === null);
  const pick = byId ?? focal ?? all[0]!;
  if (isAlreadyLiked(pick)) return { ok: false, skipReason: "already-liked" };
  const btn = findLikeButton(pick);
  if (!btn) return { ok: false, skipReason: "no-like-button" };
  btn.scrollIntoView?.({ block: "center" });
  const { x, y } = elementCenter(btn);
  return { ok: true, x, y, rect: elementRect(btn), observed: { tweet_id: tweetId(pick) } };
}

/** "comment" == X reply here; name kept for the shared actuator protocol.
 * Only an ENABLED submit is returned (X disables the button until the editor's
 * model registers text) — the background polls until one appears. */
export function locateCommentSubmit(root: ParentNode): LocateResult {
  const hit = selReplySubmitInfo(root);
  if (!hit) return { ok: false, skipReason: "submit-not-found" };
  const submit = hit.el;
  submit.scrollIntoView?.({ block: "center" });
  const rect = elementRect(submit);
  // A zero-sized rect (hidden/detached button) must NOT flow through as ok:
  // rectFrom would synthesize a 4x4 box around {0,0} and the trusted click
  // would land at the viewport corner. Skipping keeps the background's poll
  // going until the button is actually clickable.
  if (rect.width <= 0 || rect.height <= 0) return { ok: false, skipReason: "submit-zero-rect" };
  const { x, y } = elementCenter(submit);
  return {
    ok: true, x, y, rect,
    // Which pass matched + what the button looks like — the background stamps
    // this into the not-cleared skip detail so a failure row in x_activity
    // names the exact button that was clicked.
    observed: {
      via: hit.via,
      aria: (submit.getAttribute("aria-label") ?? "").slice(0, 40),
      text: (submit.textContent ?? "").trim().slice(0, 40),
      type: (submit.getAttribute("type") ?? "").slice(0, 40),
    },
  };
}

/**
