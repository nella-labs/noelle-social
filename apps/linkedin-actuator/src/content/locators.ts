import type { Rng } from "../lib/rng.js";
import {
  findFeedPosts, findLikeButton, isAlreadyLiked, isSponsored, postActivityUrn,
  findCommentBox as selCommentBox, findCommentSubmitInfo as selCommentSubmitInfo, findChallenge,
  diagnoseCommentSubmit as selDiagnoseCommentSubmit,
  commentBoxText as selCommentBoxText,
  findMessageCompose as selMessageCompose, findMessageSend as selMessageSend,
  messageComposeText as selMessageComposeText,
  wordCount as selWordCount, hasMedia as selHasMedia, isTruncated as selIsTruncated,
  findSeeMore as selFindSeeMore, findCommentsToggle as selFindCommentsToggle, hasComments as selHasComments,
  findReactionButton as selFindReactionButton,
  LIKE_BUTTON_SELECTORS, isPostUnavailable as selIsPostUnavailable,
  isCommentRestricted as selIsCommentRestricted,
} from "./selectors.js";
import { reactionLabel, type ReactionType } from "../lib/reactions.js";

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

function postAuthor(post: Element): string | null {
  return post.querySelector(".update-components-actor__name")?.textContent?.trim() ?? null;
}

/** Count of React Like buttons anywhere under root — a diagnostic for like skips. */
function countLikeButtons(root: ParentNode): number {
  const seen = new Set<Element>();
  for (const sel of LIKE_BUTTON_SELECTORS) {
    for (const el of Array.from(root.querySelectorAll(sel))) seen.add(el);
  }
  return seen.size;
}

export function locateLikeTarget(
  root: ParentNode,
  opts: { preferWatchlist: boolean; watchlistNames: string[] },
  rng: Rng,
): LocateResult {
  const all = findFeedPosts(root);
  const withBtn = all.filter((p) => findLikeButton(p));
  const likeable = withBtn.filter((p) => !isSponsored(p) && !isAlreadyLiked(p));
  if (likeable.length === 0) {
    // Diagnostic counts so a skip row in noelle.linkedin_activity says exactly
    // WHY zero posts were likeable, without a live DevTools session:
    //   btns  = React Like buttons anywhere on the page (0 ⇒ feed not loaded or
    //           the button label drifted; >0 with posts=0 ⇒ the container fallback
    //           should have caught it, so a real oddity)
    //   path  = location.pathname (≠ /feed/ ⇒ the tab wasn't on the feed — the
    //           standalone-like navigate-to-feed guard should prevent this)
    const btns = countLikeButtons(root);
    const path = (typeof location !== "undefined" && location.pathname) || "?";
    return {
      ok: false,
      skipReason: `no-likeable-post(posts=${all.length},withBtn=${withBtn.length},btns=${btns},path=${path})`,
    };
  }

  // Prefer posts in/just-below the current viewport so the click lands on a
  // visible post (and we don't scroll back up to one already passed).
  const vh = typeof window !== "undefined" ? window.innerHeight || 800 : 800;
  const inView = likeable.filter((p) => {
    const top = p.getBoundingClientRect().top;
    return top > -200 && top < vh * 1.4;
  });
  const posts = inView.length > 0 ? inView : likeable;

  let pick = posts[rng.int(0, posts.length - 1)]!;
  if (opts.preferWatchlist && opts.watchlistNames.length > 0) {
    const wl = posts.find((p) => {
      const name = postAuthor(p)?.toLowerCase() ?? "";
      return opts.watchlistNames.some((w) => name.includes(w.toLowerCase()));
    });
    if (wl) pick = wl;
    else if (rng.next() < 0.5) return { ok: false, skipReason: "no-watchlist-post" }; // sometimes hold
  }

  // Content hints for the reading model: how long to dwell before reacting,
  // whether to expand "…more", and where the expander is. Computed on the picked
  // post (the one we're about to like). seeMoreRect rides the existing locateLike
  // path so the loop can click it without a new message type.
  const wc = selWordCount(pick);
  const media = selHasMedia(pick);
  const trunc = selIsTruncated(pick);
  const seeMore = trunc ? selFindSeeMore(pick) : null;

  const btn = findLikeButton(pick)!;
  // Scroll FIRST, measure AFTER. The in-view filter admits posts up to
  // 1.4*viewport below the fold, so this scroll can move the page by hundreds
  // of px — every rect this function returns (the like rect AND seeMoreRect)
  // must be measured in the post-scroll viewport, or the loop's trusted CDP
  // click at seeMoreRect lands on a different post's content.
  btn.scrollIntoView?.({ block: "center" });
  const seeMoreRect = seeMore ? elementRect(seeMore) : undefined;
  const { x, y } = elementCenter(btn);
  return {
    ok: true, x, y, rect: elementRect(btn),
    observed: {
      activity_urn: postActivityUrn(pick),
      author_name: postAuthor(pick),
      wordCount: wc,
      hasMedia: media,
      isTruncated: trunc,
      ...(seeMoreRect ? { seeMoreRect } : {}),
    },
  };
}

export function locateCommentBox(root: ParentNode): LocateResult {
  // selCommentBox skips chat-pane textboxes outright (typing a comment there
  // — or the ⌘/Ctrl+Enter chord, which messaging treats as send — would
  // deliver it as a private message), so a page whose only textbox is a
  // messaging bubble fails the locate here.
  const box = selCommentBox(root);
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

/** The post action that opens a collapsed composer, never its submit button. */
export function locatePostCommentAction(root: ParentNode): LocateResult {
  const scope = root.querySelector("main") ?? root;
  const actions = Array.from(scope.querySelectorAll<HTMLElement>("button")).filter((button) => {
    if (button.closest("[componentkey*='commentButtonSection'], [id*='commentButtonSection']")) return false;
    const icon = button.querySelector("svg#comment-small");
    if (icon) return button.textContent?.trim() === "Comment" ||
      /^Comment(?:\b|$)/i.test(button.getAttribute("aria-label") ?? "");
    return Boolean(button.closest(".feed-shared-social-action-bar") &&
      /^Comment(?:\b|$)/i.test(button.getAttribute("aria-label") ?? ""));
  });
  // A permalink should expose exactly one post action. Multiple post cards mean
  // we cannot prove which one belongs to the target URL, so fail closed.
  if (actions.length !== 1) return { ok: false, skipReason: actions.length ? "comment-action-ambiguous" : "comment-action-not-found" };
  const button = actions[0]!;
  button.scrollIntoView?.({ block: "center" });
  const rect = elementRect(button);
  if (rect.width <= 0 || rect.height <= 0) return { ok: false, skipReason: "comment-action-zero-rect" };
  return { ok: true, ...elementCenter(button), rect };
}

export function locateCommentSubmit(root: ParentNode): LocateResult {
  const hit = selCommentSubmitInfo(root);
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
    // this into the not-cleared skip detail so a failure row in
    // linkedin_activity names the exact button that was clicked.
    observed: {
      via: hit.via,
      aria: (submit.getAttribute("aria-label") ?? "").slice(0, 40),
      text: (submit.textContent ?? "").trim().slice(0, 40),
      type: (submit.getAttribute("type") ?? "").slice(0, 40),
    },
  };
}

/**
 * Explain a submit-not-found: which of the three failure buckets (no worded
 * candidate / disabled / enabled-but-zero-rect) the page is in. Called by the
 * background ONLY on the failure path, so it never costs the happy path. Uses a
 * real getBoundingClientRect for the zero-rect test.
 */
export function diagnoseCommentSubmit(root: ParentNode): LocateResult {
  const isZeroRect = (el: HTMLElement) => {
