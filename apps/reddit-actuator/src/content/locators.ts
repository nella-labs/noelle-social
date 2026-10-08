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
  root: ParentNode,
  hostname?: string,
  scroll = true,
  /** The body this run typed. When given, ONLY a box holding it qualifies — see
   *  findDirtyReplyBox's `matches`. Absent means "any dirty box". */
  ownBody?: string,
): LocateResult {
  const flavor = detectFlavor(root, hostname);
  const box = selDirtyReplyBox(
    root, flavor,
    ownBody ? (text: string) => sameDraft(text, ownBody) : undefined,
  );
  // `present` is the caller's emptiness signal — "does anything on this page
  // hold text a click could clear" — kept as its own field rather than inferred
  // from `ok`, so a future skip shape cannot silently read as a clean page.
  //
  // There is no zero-rect branch here on purpose: findDirtyReplyBox already
  // filters candidates through the identical rect test, so a returned box is
  // always clickable. See its comment for why hidden dirty boxes are excluded
  // outright rather than reported as unclearable.
  if (!box) return { ok: false, skipReason: "no-dirty-composer", observed: { present: false } };
  // Only scroll when we are about to CLICK. This doubles as the emptiness probe
  // inside runClearComposer's poll loop, and scrolling on every read would yank
  // the operator's viewport around a dozen times per clear — the scoped
  // readReplyBox deliberately doesn't scroll either.
  if (scroll) box.scrollIntoView?.({ block: "center" });
  const { x, y } = elementCenter(box);
  // `text` rides along so the background can decide whether the draft is OURS
  // before wiping it — new Reddit persists comment drafts, so a box holding
  // something the operator typed must be left alone.
  const text = box.tagName.toLowerCase() === "textarea"
    ? ((box as HTMLTextAreaElement).value ?? "")
    : (box.textContent ?? "");
  return { ok: true, x, y, rect: elementRect(box), observed: { present: true, text: text.slice(0, 200) } };
}

/**
 * Read the (scoped) reply composer's state so the background can NAME the
 * failure when no clickable submit ever appears: observed.present=false → the
 * composer is gone (page changed / never opened), empty=false → the typed reply
 * is still sitting there un-submittable. ok is always true (a read, not an
 * action); called only on the failure path.
 */
export function readReplyBox(root: ParentNode, hostname?: string, commentId?: string): LocateResult {
  const flavor = detectFlavor(root, hostname);
  const box = selReplyBox(root, flavor, commentId);
  if (!box) return { ok: true, observed: { present: false, empty: true } };
  const content =
    box.tagName.toLowerCase() === "textarea"
      ? ((box as HTMLTextAreaElement).value ?? "")
      : (box.textContent ?? "");
  return { ok: true, observed: { present: true, empty: content.trim().length === 0 } };
}

/** Read only the exact composer; an unmounted box is not delivery evidence. */
export function verifyReplyCleared(root: ParentNode, hostname?: string, commentId?: string): {
  cleared: boolean; present: boolean; empty: boolean | null;
} {
  const result = readReplyBox(root, hostname, commentId);
  const present = result.observed?.present === true;
  const empty = present ? result.observed?.empty === true : null;
  return { cleared: present && empty === true, present, empty };
}

/**
 * Locate a feed post's UPVOTE button for an idle-upvote (operator opt-in). Mirrors
 * the LinkedIn locateLikeTarget style: scans the feed for posts NOT already
 * upvoted (findFeedUpvoteTarget) and returns a RANDOM in-view candidate's button
 * click rect (rng-driven — first-match-only is a positional fingerprint), plus the
 * observed post_id/subreddit for the activity event. ok:false with a
 * self-diagnosing "no-upvotable-post(posts=,withBtn=,btns=,path=,flavor=)" when
 * nothing is upvotable (all already upvoted, or none found — ports the LinkedIn
 * no-likeable-post diagnostics).
 * UPVOTE-ONLY — there is deliberately no downvote locator anywhere. Flavor is
 * derived from the hostname exactly like every other locator here (single source of
 * flavor detection); the background sends `{cmd:"locateUpvote"}` from the feed.
 * The observed payload also carries the post's wordCount + hasMedia so the
 * background can dwell on a human READ before landing the upvote (decideStop →
 * readingDwellMs | glanceMs), mirroring the LinkedIn read-before-like beat.
 */
export function locateUpvote(root: ParentNode, rng: Rng, hostname?: string): LocateResult {
  const flavor = detectFlavor(root, hostname);
  const found = findFeedUpvoteTarget(root, flavor, rng);
  if (!found) {
    // Diagnostic counts so a skip row in noelle.reddit_activity says exactly WHY
    // zero posts were upvotable, without a live DevTools session:
    //   posts   = feed post containers found (0 ⇒ not on a listing, or DOM drift)
    //   withBtn = posts carrying ANY upvote button, pressed or not (withBtn>0 with
    //             no target ⇒ everything in view is already upvoted)
    //   btns    = upvote buttons anywhere on the page, incl. shadow roots (btns>0
    //             with posts=0 ⇒ container drift while the affordance survived)
    //   path    = location.pathname (a /comments/ permalink ⇒ the navigate-to-feed
    //             guard didn't take — the tab never returned to a feed)
    const posts = findFeedPosts(root, flavor);
    const withBtn = posts.filter((p) => postHasUpvoteButton(p, flavor)).length;
    const btns = countUpvoteButtons(root, flavor);
    const path = (typeof location !== "undefined" && location.pathname) || "?";
    return {
      ok: false,
      skipReason: `no-upvotable-post(posts=${posts.length},withBtn=${withBtn},btns=${btns},path=${path},flavor=${flavor})`,
    };
  }
  return hit(found.el, {
    flavor,
    post_id: postId(found.post, flavor),
    subreddit: postSubreddit(found.post, flavor),
    // Dwell hints for the read-before-upvote beat (postWordCount/postHasMedia are
    // already imported for the ambient-read locators).
    wordCount: postWordCount(found.post, flavor),
    hasMedia: postHasMedia(found.post, flavor),
  });
}

/**
 * Locate the SAVE affordance for an idle post-save (operator opt-in; DEFAULT-OFF;
 * SAVE-ONLY — a post-save is a private bookmark, NOT a vote, so it never touches
 * the vote-manipulation clause). Mirrors locateUpvote: scans the feed for a post
 * NOT already saved (findFeedSaveTarget) and returns a RANDOM in-view candidate's
 * save affordance click rect (rng-driven — first-match-only is a positional
 * fingerprint), plus the observed post_id/subreddit for the activity event.
 *
 * New Reddit: Save lives inside the post's overflow "…" menu, so the returned
 * rect is the menu OPENER and observed.needsMenu=true — the background clicks it
 * to open the menu, then sends {cmd:"locateSaveInMenu"} for the Save item. Old
 * Reddit: the `.save-button` link is a direct one-click save
 * (observed.needsMenu=false). ok:false with a self-diagnosing skipReason when
 * nothing is saveable (all already saved, or none found) → the background falls
 * back to a plain upvote so the idle engagement is never lost. Flavor is derived
 * from the hostname exactly like every other locator here. SAVE-ONLY — there is
 * deliberately no downvote locator anywhere.
 */
export function locateSave(root: ParentNode, rng: Rng, hostname?: string): LocateResult {
  const flavor = detectFlavor(root, hostname);
  const found = findFeedSaveTarget(root, flavor, rng);
  if (!found) {
    const path = (typeof location !== "undefined" && location.pathname) || "?";
    return { ok: false, skipReason: `no-saveable-post(path=${path},flavor=${flavor})` };
  }
  // hit() scrollIntoViews the target (safe: the post/opener is not a transient
  // popup — unlike the menu item below), so the returned rect is FRESH.
  return hit(found.el, {
    flavor,
    needsMenu: flavor === "new", // new Reddit: click opens the overflow menu; old: one-click save
    post_id: postId(found.post, flavor),
    subreddit: postSubreddit(found.post, flavor),
  });
}

/**
 * Locate the "Save" item inside the OPEN overflow menu (New Reddit two-step). The
 * background calls this after clicking the menu opener locateSave returned.
 * Mirrors x-actuator locateRepostConfirm: deliberately does NOT scrollIntoView —
 * the menu is already in view and a scroll would dismiss it. ok:false when the
 * menu isn't open / the item drifted → the background Escape-dismisses the menu
 * and falls back to a plain upvote (the engagement is never lost). Old Reddit
 * saves in one click, so there is no menu step there.
 */
export function locateSaveInMenu(root: ParentNode, hostname?: string): LocateResult {
  const flavor = detectFlavor(root, hostname);
  if (flavor === "old") return { ok: false, skipReason: "save-menu-old-reddit" };
  const item = findSaveMenuItem(root);
  if (!item) return { ok: false, skipReason: "save-item-not-found" };
  const { x, y } = elementCenter(item);
  return { ok: true, x, y, rect: elementRect(item) }; // no scrollIntoView — would dismiss the menu
}

/** Ambient decoy: a read-only "…more" / expand affordance. Non-counted. */
export function locateAmbientExpand(root: ParentNode, _rng: Rng, hostname?: string): LocateResult {
  const flavor = detectFlavor(root, hostname);
  const btn = findAmbientExpand(root, flavor);
  if (!btn) return { ok: false, skipReason: "nothing-to-expand" };
  const post = findPost(root, flavor);
  return hit(btn, {
    wordCount: post ? postWordCount(post, flavor) : 40,
    hasMedia: post ? postHasMedia(post, flavor) : false,
  });
}

/** Ambient decoy: a read-only "open this thread to read" affordance. Non-counted. */
export function locateAmbientComments(root: ParentNode, _rng: Rng, hostname?: string): LocateResult {
  const flavor = detectFlavor(root, hostname);
  const found = findAmbientComments(root, flavor);
  if (!found) return { ok: false, skipReason: "no-thread-to-open" };
  return hit(found.el, { hasMedia: postHasMedia(found.post, flavor) });
}

/** Classify a challenge/throttle interstitial (see selectors.detectChallenge). */
export function detectChallenge(root: ParentNode, opts: { url?: string; title?: string } = {}): ChallengeResult {
  return selDetectChallenge(root, opts);
}

/**
 * Is the target post removed / deleted / unavailable? Derives the flavor exactly
 * like every other locator here (single source of flavor detection) and delegates
 * to the read-only selector. The background calls this right after navigation and
 * skips a removed post WITHOUT ever opening the composer. `positive` rides along
 * so the background can tell CONFIRMED removal (durable skip allowed) from a
 * merely-absent post shell (`post-absent` — transient interstitials produce it
 * too, so session-local handling only). Read-only.
 */
export function checkPostRemoved(
  root: ParentNode,
  hostname?: string,
): { removed: boolean; reason?: string; positive?: boolean } {
  const flavor = detectFlavor(root, hostname);
  const { unavailable, reason, positive } = isPostUnavailable(root, flavor);
  return { removed: unavailable, ...(reason ? { reason } : {}), ...(positive ? { positive } : {}) };
}

/**
 * Are the thread's comments locked/archived — i.e. will a composer NEVER render?
 * Derives the flavor exactly like every other locator here and delegates to the
 * read-only selector. The background calls this right after the removed-post gate
 * (and re-probes on a missing reply box, since the banner can render late) and
 * skips a blocked thread WITHOUT ever hunting for a composer. Read-only.
 */
export function checkCommentsLocked(root: ParentNode, hostname?: string): { blocked: boolean; reason?: string } {
  const flavor = detectFlavor(root, hostname);
  const { blocked, reason } = isCommentsUnavailable(root, flavor);
  return { blocked, ...(reason ? { reason } : {}) };
}
