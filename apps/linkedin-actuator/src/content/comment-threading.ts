// Comment-level threading — replying UNDER the person who replied to us.
//
// Until now Lyra could only comment at POST level. For a conversation reply
// that is wrong in a way that is worse than not replying: it publishes a SECOND
// top-level comment from the operator on a thread he had already commented on.
// Five of those reached LinkedIn before the dedup was tightened
// (docs/notifications-actor.md), and the dedup now drops conversation replies
// entirely because a post-level "reply" is never the right artifact.
//
// This module is what lets that dedup be relaxed again — safely. It finds ONE
// specific comment, opens ITS reply box, and proves the box it opened is a reply
// box rather than the post composer.
//
// LIVE-TUNE, from a real capture (tests/fixtures/post-comments-2026.html):
//
//   <div id="replaceableComment_urn:li:comment:(urn:li:ugcPost:<POST>,<COMMENT>)"
//        componentkey="replaceableComment_urn:li:comment:(...)">
//     <div componentkey="CommentComponentReference_urn:li:comment:(...)">
//       …author, body…
//       <button aria-label="Reply">        ← THIS comment's reply button
//
// The comment urn is carried on the element `id`, which is the whole reason
// threading is possible: the notifications sweep already stores that same
// trailing comment id as the lead's external_id, so the target survives from
// harvest all the way to actuation with no guessing.
//
// The Reply BUTTON's componentkey is a fresh uuid per render, so it is useless
// as a locator; `aria-label="Reply"` scoped to the comment container is the
// stable path.

import { elementCenter, elementRect, type LocateResult } from "./locators.js";
import { normalizeEditorText } from "./selectors.js";

/**
 * A hit carries click coords + rect, exactly like every other locator here —
 * including the two things they all do and this originally skipped:
 *
 *  - scroll into view BEFORE measuring. A targeted comment is routinely
 *    hundreds of px down a long thread, so a pre-scroll rect is the wrong box.
 *  - refuse a zero rect. `rectFrom` (background/index.ts) synthesizes a 4x4 box
 *    at {0,0} for an empty rect, so a hidden/detached element would send a
 *    trusted click to the VIEWPORT CORNER instead of failing.
 */
function hit(el: Element, what: string): LocateResult {
  (el as HTMLElement).scrollIntoView?.({ block: "center" });
  const rect = elementRect(el);
  if (rect.width <= 0 || rect.height <= 0) return miss(`${what}:zero-rect`);
  return { ok: true, ...elementCenter(el), rect };
}
function miss(skipReason: string, observed?: Record<string, unknown>): LocateResult {
  return observed ? { ok: false, skipReason, observed } : { ok: false, skipReason };
}

const COMMENT_CONTAINERS = {
  legacy: '[data-id*="urn:li:comment:"]',
  current: '[id*="replaceableComment_urn:li:comment:"]',
  keyed: '[componentkey^="replaceableComment_urn:li:comment:"], [componentkey^="CommentComponentReference_urn:li:comment:"]',
} as const;

/**
 * Comment id → the element holding that comment.
 *
 * Matched on the id's SUFFIX (`,<commentId>)`), not on the whole urn: the post
 * half of the tuple renders as ugcPost/activity/share depending on the post
 * type, and the sweep does not always store the same variant it will later see
 * in the DOM. The comment half is globally unique, so the suffix is both
 * sufficient and more robust.
 *
 * Anchored on `)` so comment `…456` can never match comment `…4567`.
 */
export function locateCommentByUrn(root: ParentNode, commentId: string): Element | null {
  const id = String(commentId ?? "").trim();
  if (!id || !/^\d+$/.test(id)) return null;
  const suffix = `,${id})`;

  // LEGACY EMBER first — it is what a POST PERMALINK actually serves, and
  // missing it is why every threaded run failed with `comment-not-found`:
  //   <article class="comments-comment-entity"
  //            data-id="urn:li:comment:(ugcPost:<POST>,<COMMENT>)">
  // Note the post half is `ugcPost:` with NO `urn:li:` prefix, which is exactly
  // why this matches on the ",<id>)" SUFFIX rather than the whole urn — the
  // comment half is identical across both generations.
  const byData = Array.from(root.querySelectorAll<HTMLElement>(COMMENT_CONTAINERS.legacy)).filter(
    (el) => (el.getAttribute("data-id") ?? "").endsWith(suffix),
  );
  if (byData.length > 0) {
    // Replies are NESTED inside the parent comment here, so prefer the
    // innermost match — otherwise a parent would be returned for its child's id.
    return byData.find((c) => !byData.some((o) => o !== c && c.contains(o))) ?? byData[0]!;
  }

  const candidates = Array.from(
    root.querySelectorAll<HTMLElement>(COMMENT_CONTAINERS.current),
  );
  const byId = candidates.find((el) => (el.getAttribute("id") ?? "").endsWith(suffix));
  if (byId) return byId;
  // Fallback: the componentkey carries the same urn. Restricted to the two keys
  // that really are comment CONTAINERS — other elements (a replies-thread
  // wrapper, say) are keyed by a comment urn too, and taking one of those would
  // scope the Reply-button search to a subtree holding OTHER people's comments,
  // returning the wrong person's button while reporting success.
  const byKey = Array.from(root.querySelectorAll<HTMLElement>(COMMENT_CONTAINERS.keyed)).filter(
    (el) => (el.getAttribute("componentkey") ?? "").endsWith(suffix),
  );
  if (byKey.length === 0) return null;
  // Innermost = the one containing no other keyed comment container.
  return byKey.find((c) => !byKey.some((o) => o !== c && c.contains(o))) ?? byKey[byKey.length - 1]!;
}

/** The comment id out of a full urn, tolerating both stored shapes. */
export function commentIdOf(urnOrId: string | null | undefined): string | null {
  const s = String(urnOrId ?? "").trim();
  if (!s) return null;
  if (/^\d+$/.test(s)) return s;
  // urn:li:comment:(urn:li:ugcPost:123,456)  →  456
  const tuple = /urn:li:comment:\([^,)]+,(\d+)\)/.exec(s);
  if (tuple) return tuple[1]!;
  // urn:li:comment:456  →  456   (the shape the sweep stores)
  const flat = /urn:li:comment:(\d+)/.exec(s);
  return flat ? flat[1]! : null;
}

function containerCommentId(container: Element): string | null {
  for (const attribute of ["data-id", "id", "componentkey"] as const) {
    const id = commentIdOf(container.getAttribute(attribute));
    if (id) return id;
  }
  return null;
}

/**
 * That comment's own Reply button.
 *
 * Scoped INSIDE the comment container, so it can never pick up the neighbouring
 * comment's button — which would answer the wrong person, in public, under
 * their name.
 */
export function locateCommentReplyButton(root: ParentNode, commentId: string): LocateResult {
  const id = commentIdOf(commentId);
  if (!id) return miss("comment-reply:bad-id");
  const comment = locateCommentByUrn(root, id);
  if (!comment) return miss("comment-reply:comment-not-found");
  // Legacy labels the button "Reply to <Name>’s comment"; the 2026 markup uses
  // a bare "Reply". Both are accepted, but the class-scoped legacy hook is tried
  // FIRST — on a nested thread the parent's article also contains its children's
  // reply buttons, and the parent's own bar is the one carrying that class at
  // this level.
  const own = Array.from(
    comment.querySelectorAll<HTMLElement>(
      'button[class*="comments-comment-social-bar__reply-action-button"], button[aria-label^="Reply"], button[aria-label="Reply"]',
    ),
  );
  // The nearest one that is not inside a DEEPER comment — i.e. this comment's
  // own, not a nested reply's.
  const btn = own.find((b) => b.closest("[data-id]") === comment || !b.closest("[data-id]")) ?? own[0];
  if (!btn) return miss("comment-reply:no-reply-button");
  return hit(btn, "comment-reply");
}

/** Composer containers, most specific first. */
const COMPOSER_SEL = [
  '[componentkey^="commentBox-"]',
  '[data-testid="ui-core-tiptap-text-editor-wrapper"]',
  // Legacy ember: a Quill editor inside comments-comment-box / -texteditor.
  '[class*="comments-comment-box"]',
  '[class*="comments-comment-texteditor"]',
] as const;

/** The editable inside a composer. */
const EDITOR_SEL =
  '[contenteditable="true"][role="textbox"], .tiptap.ProseMirror[contenteditable="true"], .ql-editor[contenteditable="true"], [contenteditable="true"]';

/**
 * The reply composer that opened after clicking a comment's Reply button.
 *
 * `opts.after` scopes the search to composers that appear at or after the
 * comment in document order — LinkedIn renders the reply box as a SIBLING of
 * the comment, not a child of it, so a document-order rule is what separates
 * "the box that just opened under Malena" from the post-level composer that has
 * been sitting at the top of the section all along.
 */
/**
 * The composer that belongs to ONE named comment — or a refusal.
 *
 * `afterCommentId` is REQUIRED and the anchor must resolve. The first version
 * made it optional and fell through to "the first composer on the page" when
 * the anchor was missing, which is the same class of bug as the one that put
 * five duplicate comments on the operator's threads: a target that resolves to
 * NOTHING produced a confident hit on somebody else's reply box, and with a
 * real post-level composer on the page it resolved to THAT — so the caller
 * would have typed a private-sounding conversation reply into the "Add a
 * comment" field. The comment list is a virtualized LazyColumn, so an anchor
 * genuinely can vanish between the Reply click and this read. Refusing is the
 * only safe answer.
 */
function findReplyEditor(
  root: ParentNode,
  opts: { afterCommentId: string },
): { editor: HTMLElement; box: HTMLElement } | { skipReason: string } {
  const anchorId = commentIdOf(opts?.afterCommentId ?? "");
