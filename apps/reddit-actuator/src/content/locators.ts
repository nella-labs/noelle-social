import type { Rng } from "../lib/rng.js";
import { sameDraft } from "@noelle/actuator-cdp";
import {
  detectFlavor,
  findPost, postWordCount, postHasMedia, postId, postSubreddit,
  findComments, commentId as selCommentId, commentAuthor,
  commentReplyButton, findComposerEntry,
  findReplyBox as selReplyBox, findDirtyReplyBox as selDirtyReplyBox,
  findReplySubmitInfo as selReplySubmitInfo, submitDisabled,
  diagnoseReplySubmit as selDiagnoseReplySubmit,
  findAmbientExpand, findAmbientComments, findFeedUpvoteTarget,
  findFeedSaveTarget, findSaveMenuItem,
  findFeedPosts, postHasUpvoteButton, countUpvoteButtons,
  detectChallenge as selDetectChallenge, type ChallengeResult,
  isPostUnavailable, isCommentsUnavailable,
} from "./selectors.js";

export interface LocateResult {
  ok: boolean;
  x?: number;
  y?: number;
  /**
   * The element's bounding rect (rounded). Carried alongside the center coords so
   * the CDP layer can sample a 2D-Gaussian click point and derive the Fitts
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

function hit(el: Element, observed?: Record<string, unknown>): LocateResult {
  (el as HTMLElement).scrollIntoView?.({ block: "center" });
  const { x, y } = elementCenter(el);
  return { ok: true, x, y, rect: elementRect(el), ...(observed ? { observed } : {}) };
}

/**
 * The post-composer entry to click before typing under the POST.
 *
 * New Reddit: the collapsed `faceplate-textarea-input` proxy — clicking it
 * expands the real editable (which is 0×0 until then). Reported with
 * observed.needsExpand=true so the background clicks it and then waits for the
 * editable's rect to become non-zero.
 *
 * Old Reddit: the post comment box is a plain always-visible textarea, so this
 * returns its rect directly (observed.needsExpand=false) — no expand step.
 */
export function locateComposerEntry(root: ParentNode, hostname?: string): LocateResult {
  const flavor = detectFlavor(root, hostname);
  if (flavor === "old") {
    const box = selReplyBox(root, "old");
    if (!box) return { ok: false, skipReason: "old-post-box-not-found" };
    return hit(box, { flavor, needsExpand: false });
  }
  const entry = findComposerEntry(root, "new");
  if (!entry) return { ok: false, skipReason: "composer-entry-not-found" };
  return hit(entry, { flavor, needsExpand: true });
}

/**
 * The Reply button of the target comment. When a `commentId` is PROVIDED it MUST
 * match a comment node — otherwise this returns ok:false ("target-comment-not-
 * found"). It NEVER falls back to the first comment for a provided-but-missing id,
 * because that would post the reply under the WRONG user's comment. The focused /
 * highest-in-DOM comment is used ONLY when no commentId is given (e.g. a single-
 * comment permalink page).
 */
export function locateCommentReplyButton(root: ParentNode, commentId?: string, hostname?: string): LocateResult {
  const flavor = detectFlavor(root, hostname);
  const comments = findComments(root, flavor);
  if (comments.length === 0) return { ok: false, skipReason: "no-comments-found" };
  let target: Element;
  if (commentId) {
    const match = comments.find((c) => selCommentId(c, flavor) === commentId);
    if (!match) return { ok: false, skipReason: "target-comment-not-found" };
    target = match;
  } else {
    target = comments[0]!;
  }
  const btn = commentReplyButton(target, flavor);
  if (!btn) return { ok: false, skipReason: "comment-reply-button-not-found" };
  return hit(btn, { flavor, comment_id: selCommentId(target, flavor), author: commentAuthor(target, flavor) });
}

/**
 * Guard the background applies BEFORE it clicks a comment's Reply button: does the
 * located node actually match the intended target? `observed.comment_id` is the
 * t1_-stripped id the locator read off the node it picked; `commentId` is the
 * t1_-stripped id we asked for (both already prefix-stripped). Fail-CLOSED — a
 * missing or mismatched id returns false so a reply is NEVER posted under an
 * unverified comment. When no specific comment was requested there is nothing to
 * verify (post / permalink focus).
 */
export function locatedCommentMatches(
  observed: Record<string, unknown> | undefined,
  commentId: string | undefined,
): boolean {
  if (!commentId) return true;
  return observed?.comment_id === commentId;
}

/**
 * The active reply editable/textarea. Readiness gate: the box must have a
 * non-zero rect (the new-Reddit editable is 0×0 until the composer expands), so
 * the background can poll this a few times before typing.
 */
export function locateReplyBox(root: ParentNode, hostname?: string, commentId?: string): LocateResult {
  const flavor = detectFlavor(root, hostname);
  const box = selReplyBox(root, flavor, commentId);
  if (!box) return { ok: false, skipReason: "reply-box-not-found" };
  box.scrollIntoView?.({ block: "center" });
  const rect = elementRect(box);
  if (rect.width <= 0 || rect.height <= 0) return { ok: false, skipReason: "reply-box-not-ready" };
  const { x, y } = elementCenter(box);
  return { ok: true, x, y, rect, observed: { flavor } };
}

/**
 * The active reply submit button ("Comment" on new Reddit, "save" on old), scoped
 * to the target comment's composer when `commentId` is given. Returns ok:false with
 * "reply-submit-disabled" when the only submit is disabled/aria-disabled — a
 * disabled button means the typed text has not registered, so the reply is NOT
 * ready to post and must not be recorded as sent — and "submit-zero-rect" when
 * the resolved button has no layout box: rectFrom would synthesize a 4×4 box
 * around {0,0} and the trusted click would land at the viewport corner. Skipping
 * keeps the background's poll going until the button is actually clickable.
 * `observed` names the button (via/text/type/slot) so a not-cleared failure row
 * in reddit_activity says WHICH button was clicked — the real submit or a decoy
 * — without a live DevTools session (blocked during a run).
 */
export function locateReplySubmit(root: ParentNode, hostname?: string, commentId?: string): LocateResult {
  const flavor = detectFlavor(root, hostname);
  const found = selReplySubmitInfo(root, flavor, commentId);
  if (!found) return { ok: false, skipReason: "reply-submit-not-found" };
  const submit = found.el;
  if (submitDisabled(submit)) return { ok: false, skipReason: "reply-submit-disabled" };
  submit.scrollIntoView?.({ block: "center" });
  const rect = elementRect(submit);
  if (rect.width <= 0 || rect.height <= 0) return { ok: false, skipReason: "submit-zero-rect" };
  const { x, y } = elementCenter(submit);
  return {
    ok: true, x, y, rect,
    observed: {
      flavor,
      via: found.via,
      text: (((submit.getAttribute("aria-label") || submit.textContent) ?? "")).trim().slice(0, 40),
      type: (submit.getAttribute("type") ?? "").slice(0, 40),
      slot: (submit.getAttribute("slot") ?? "").slice(0, 40),
    },
  };
}

/**
 * Explain a reply-submit miss: re-walks the locator predicates into buckets
 * (box present, scoped/slot hit counts, disabled, zero-rect — see
 * selectors.ReplySubmitDiag) so the background can fold WHY into the
 * `reply-failed:submit-not-found(...)` reason. Called ONLY on the failure path,
 * so it never costs the happy path. Uses a real getBoundingClientRect for the
 * zero-rect test; `pathname` (sanitized upstream) locates the page the miss
 * happened on.
 */
export function diagnoseReplySubmit(
  root: ParentNode,
  hostname?: string,
  commentId?: string,
  pathname?: string,
): LocateResult {
  const flavor = detectFlavor(root, hostname);
  const isZeroRect = (el: HTMLElement) => {
    const r = el.getBoundingClientRect();
    return r.width <= 0 || r.height <= 0;
  };
  return {
    ok: true,
    observed: {
      ...selDiagnoseReplySubmit(root, flavor, isZeroRect, commentId),
      ...(pathname ? { path: pathname } : {}),
    },
  };
}

/**
 * Locate the composer that is currently HOLDING TEXT, for the clear-before-
 * navigate path. `ok:false` means nothing on the page is dirty — i.e. nothing to
 * clear, and no navigation dialog to fear. See findDirtyReplyBox for why the
 * unscoped clear must ask this rather than reusing locateReplyBox.
 */
export function locateDirtyReplyBox(
