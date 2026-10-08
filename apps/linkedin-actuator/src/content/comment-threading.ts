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
  if (!anchorId) return { skipReason: "reply-composer:bad-target-id" };
  const anchor = locateCommentByUrn(root, anchorId);
  if (!anchor) return { skipReason: "reply-composer:comment-not-found" };

  // Every tier, not the first that matches globally: if one composer on the
  // page still uses the old key and the TARGET's has drifted to the newer
  // shape, short-circuiting on tier 1 would hide the target's box and hand back
  // the unrelated one.
  const boxes: HTMLElement[] = [];
  const seen = new Set<HTMLElement>();
  for (const sel of COMPOSER_SEL) {
    for (const el of Array.from(root.querySelectorAll<HTMLElement>(sel))) {
      if (!seen.has(el)) { seen.add(el); boxes.push(el); }
    }
  }
  if (boxes.length === 0) return { skipReason: "reply-composer:none-open" };

  const after = boxes.filter(
    (b) => anchor.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).sort((a, b) => a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1);
  if (after.length === 0) return { skipReason: "reply-composer:none-after-comment" };
  const containers = Object.values(COMMENT_CONTAINERS).join(", ");
  const ownerId = (element: Element): string | null => {
    const owner = element.closest(containers);
    return owner ? containerCommentId(owner) : null;
  };
  // An explicitly owned composer can follow a nested child's open editor.
  // Adjacent boxes have no comment ancestor and need the boundary check below.
  const owned = after.find((box) => ownerId(box) === anchorId);
  const pick = owned ?? after.find((box) => ownerId(box) === null);
  if (!pick) return { skipReason: "reply-composer:not-this-comments-box" };

  // BELONGING, not merely order. "First composer below the comment" is not the
  // same as "this comment's composer": if the target's box never opened (a
  // missed click, a render race, a box left open by an earlier run) the next
  // comment's box is also below the anchor and would be used to answer the
  // wrong human, in public, under the operator's name. The label check cannot
  // catch that — EVERY reply box submits with "Reply". So: refuse if another
  // comment container sits between the anchor and the box we picked.
  const between = Array.from(root.querySelectorAll<HTMLElement>(containers)).filter(
    (c) =>
      c !== anchor &&
      !c.contains(anchor) &&
      containerCommentId(c) !== anchorId &&
      anchor.compareDocumentPosition(c) & Node.DOCUMENT_POSITION_FOLLOWING &&
      c.compareDocumentPosition(pick) & Node.DOCUMENT_POSITION_FOLLOWING,
  );
  if (!owned && between.length > 0) return { skipReason: "reply-composer:not-this-comments-box" };

  const editor = Array.from(pick.querySelectorAll<HTMLElement>(EDITOR_SEL)).find(
    (element) => ownerId(element) === anchorId || ownerId(element) === null,
  );
  if (!editor) return { skipReason: "reply-composer:no-editor" };
  return { editor, box: pick };
}

/** The reply composer's editable, as a clickable/typable target. */
export function locateReplyComposer(root: ParentNode, opts: { afterCommentId: string }): LocateResult {
  const found = findReplyEditor(root, opts);
  return "editor" in found ? hit(found.editor, "reply-composer") : miss(found.skipReason);
}

/**
 * The composer's submit button — and the SAFETY CHECK.
 *
 * A reply box's submit reads "Reply"; the post-level composer's reads
 * "Comment". Requiring the word "Reply" is therefore not cosmetic: it is what
 * makes it impossible to type a conversation answer and publish it as a new
 * top-level comment, which is the exact failure this whole module exists to
 * prevent. If the button says anything else we refuse rather than guess.
 */
export function locateReplySubmit(
  root: ParentNode,
  opts: { afterCommentId: string; expectMention?: string },
): LocateResult {
  const found = findReplyEditor(root, opts);
  if (!("editor" in found)) return miss(found.skipReason);

  // Second, INDEPENDENT proof of identity when the caller knows who it is
  // answering. LinkedIn pre-fills a reply box with a mention chip naming that
  // person, so this catches a mis-targeted box that document order alone would
  // have accepted. Cheap, and the cost of being wrong is a public reply to the
  // wrong human.
  if (opts.expectMention) {
    const chip = mentionText(found.editor);
    const want = opts.expectMention.replace(/\s+/g, " ").trim().toLowerCase();
    if (!chip || !want || chip.toLowerCase().split(" ")[0] !== want.split(" ")[0]) {
      return miss("reply-submit:wrong-person", { chip, expected: opts.expectMention });
    }
  }

  // Walk up from the editor until we meet the container holding the submit.
  let scope: Element | null = found.editor;
  for (let i = 0; i < 8 && scope; i++) {
    const section = scope.querySelector<HTMLElement>('[id*="commentButtonSection"], [componentkey*="commentButtonSection"]');
    if (section) {
      // Skip disabled buttons the way selectors.ts does: the 2026 submit is
      // disabled until typing registers, and clicking it is a silent no-op that
      // would otherwise be reported as a successful send.
      const btn = Array.from(section.querySelectorAll<HTMLElement>("button")).find(
        (b) =>
          /^reply$/i.test((b.textContent ?? "").replace(/\s+/g, " ").trim()) &&
          !(b as HTMLButtonElement).disabled &&
          b.getAttribute("aria-disabled") !== "true",
      );
      if (btn) return hit(btn, "reply-submit");
      const wrong = Array.from(section.querySelectorAll<HTMLElement>("button"))
        .map((b) => (b.textContent ?? "").replace(/\s+/g, " ").trim())
        .filter(Boolean);
      return miss("reply-submit:not-a-reply-box", { labels: wrong });
    }
    scope = scope.parentElement;
  }
  return miss("reply-submit:no-button-section");
}

/**
 * Is this composer really threaded under the person we mean to answer?
 *
 * LinkedIn pre-fills a reply box with a non-editable mention chip naming that
 * person. Reading it back is a cheap, independent confirmation that the click
 * landed on the right comment — worth having, because the cost of being wrong
 * is a public reply addressed to the wrong human.
 */
function mentionText(editor: HTMLElement): string | null {
  const chip = editor.querySelector<HTMLElement>('[data-type="mention"]');
  const text = (chip?.textContent ?? "").replace(/\s+/g, " ").trim();
  return text || null;
}

export function replyComposerMention(root: ParentNode, opts: { afterCommentId: string }): string | null {
  const found = findReplyEditor(root, opts);
  if (!("editor" in found)) return null;
  return mentionText(found.editor);
}

/** Read this target's body without treating its persistent mention as text. */
export function readReplyComposer(root: ParentNode, opts: { afterCommentId: string }): LocateResult {
  const found = findReplyEditor(root, opts);
  if (!("editor" in found)) {
    // The anchor was resolved before these two absence results. Missing targets
    // or foreign/partially mounted editors remain unknown, not a sent receipt.
    if (["reply-composer:none-open", "reply-composer:none-after-comment"].includes(found.skipReason)) {
      return { ok: true, observed: { present: false, empty: true, text: "" } };
    }
    return miss(found.skipReason);
  }
  const copy = found.editor.cloneNode(true) as HTMLElement;
  copy.querySelectorAll('[data-type="mention"]').forEach((mention) => mention.remove());
  const text = normalizeEditorText(copy.textContent ?? "");
  return { ok: true, observed: { present: true, empty: text.length === 0, text } };
}

/**
 * The "See N more comments" / "Load more comments" control.
 *
 * THIS is why the first threaded runs all failed with
 * `thread-comment-reply:comment-not-found`. LinkedIn renders only a handful of
 * comments on a post and hides the rest behind this button — so the comment we
 * were sent to answer was simply not in the DOM, no matter how correct the
 * locator was. The actuator has to expand the thread the way a person does.
 *
 * Real markup (tests/fixtures/post-comments-2026.html):
 *   <div id="…-replaceableLoadMoreComments">
 *     <div role="button" …><p>See 33 more comments</p></div>
 */
const MORE_COMMENTS = /^(see|show|load)\s+(\d+\s+)?(more\s+)?(previous\s+)?comments?$/i;

export function locateLoadMoreComments(root: ParentNode): LocateResult {
  const scopes: Element[] = [
    ...Array.from(root.querySelectorAll('[id*="replaceableLoadMoreComments"]')),
    ...Array.from(root.querySelectorAll('[componentkey*="LoadMoreComments"]')),
    ...Array.from(root.querySelectorAll('[class*="load-more-container"]')),
  ];
  // Class-agnostic fallback: any clickable whose whole label is the phrase.
  const clickables: Element[] = scopes.length
    ? scopes.flatMap((sc) => Array.from(sc.querySelectorAll('[role="button"], button')))
    : Array.from(root.querySelectorAll('[role="button"], button'));

  const btn =
    clickables.find((el) =>
      MORE_COMMENTS.test((el.textContent ?? "").replace(/\s+/g, " ").trim()),
    ) ??
    // Legacy ember labels it on the button, not in the text.
    (root.querySelector<HTMLElement>(
      'button[aria-label="Load more comments"], button[class*="load-more-comments-button"]',
    ) ?? undefined);
  if (!btn) return miss("load-more-comments:not-found");
  return hit(btn, "load-more-comments");
}

/**
 * The post permalink that DEEP-LINKS to one comment.
 *
 * LinkedIn scrolls to and expands the thread around `commentUrn`, which is how
 * a human arrives from a notification. Navigating here instead of to the bare
 * post is the difference between the comment being on screen and being behind
 * "See 33 more comments".
 *
 * The param needs the TUPLE form — `urn:li:comment:(<post>,<id>)` — while the
