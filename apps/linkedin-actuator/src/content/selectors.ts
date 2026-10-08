/** Container selectors for a feed post, broadest-last. Exported so the like path
 * can report which one (if any) matched when a like is skipped. */
export const FEED_POST_SELECTORS = [
  "div.feed-shared-update-v2[data-urn]",
  "[data-urn^='urn:li:activity:']",
  "[data-id^='urn:li:activity:']",
  "div.feed-shared-update-v2",
  "[data-finite-scroll-hotkey-item]",
];

export function findFeedPosts(root: ParentNode): Element[] {
  // Broadened across LinkedIn feed variants — the `no-likeable-post(posts=0)`
  // skips came from the tight `data-urn^=activity` pair missing the current
  // markup (or the tab not being on the feed). Dedupe across selectors.
  const out = new Set<Element>();
  for (const sel of FEED_POST_SELECTORS) {
    for (const el of Array.from(root.querySelectorAll(sel))) out.add(el);
  }
  // September 2026 feed cards carry the activity URN on a header anchor and
  // use obfuscated container classes. The containing list item is the card.
  const rootEl = root instanceof Element ? root : null;
  for (const marker of root.querySelectorAll("[data-sdui-anchor-id^='feed-header-urn:li:activity:']")) {
    const card = marker.closest("[role='listitem']");
    if (card && (!rootEl || rootEl.contains(card))) out.add(card);
  }
  // Drift-resistant fallback: when EVERY container selector above misses (this
  // was the live `posts=0` cause — LinkedIn renames feed-update container
  // classes/attrs regularly), derive posts from their Like buttons instead. The
  // reaction button keeps its "React Like" aria-label across redesigns (the
  // reply-coupled like still lands via findLikeButton), so each Like button ⇒
  // climb to the post-sized container that wraps exactly it. Fully class-/attr-
  // agnostic, so standalone feed-likes survive container-markup churn.
  if (out.size === 0) {
    for (const btn of findLikeButtons(root)) {
      const post = postContainerOf(btn, rootEl);
      if (post) out.add(post);
    }
  }
  return Array.from(out);
}

/** Every "React Like" button under root (order-preserving, deduped). */
function findLikeButtons(root: ParentNode): Element[] {
  const seen = new Set<Element>();
  for (const sel of LIKE_BUTTON_SELECTORS) {
    for (const el of Array.from(root.querySelectorAll(sel))) seen.add(el);
  }
  return Array.from(seen);
}

/**
 * The post-sized container that wraps a single Like button: the LARGEST ancestor
 * that still contains exactly this one Like button (its parent would also wrap
 * the next post's Like button). This lands on the feed list-item / card even
 * when its class and data-urn have changed, so isSponsored / postActivityUrn /
 * postAuthor (which query within the returned container) still work.
 */
function postContainerOf(btn: Element, rootEl: Element | null): Element | null {
  let node: Element | null = btn.parentElement;
  let best: Element | null = null;
  while (node && node !== rootEl) {
    if (findLikeButtons(node).length === 1) best = node;
    else break; // parent now wraps a second post → stop at the previous ancestor
    node = node.parentElement;
  }
  return best;
}

export function postActivityUrn(post: Element): string | null {
  const urn = post.getAttribute("data-urn");
  if (urn && urn.startsWith("urn:li:activity:")) return urn;
  const nested = post.querySelector("[data-urn^='urn:li:activity:']");
  if (nested) return nested.getAttribute("data-urn");
  const header = post.querySelector("[data-sdui-anchor-id^='feed-header-urn:li:activity:']");
  return header?.getAttribute("data-sdui-anchor-id")?.match(/urn:li:activity:\d+/)?.[0] ?? null;
}

export function isSponsored(post: Element): boolean {
  // Current cards put the disclosure in its own span. textContent merges
  // adjacent elements ("PromotedAcme"), so word boundaries on the whole card
  // alone can miss a sponsored post.
  for (const label of post.querySelectorAll("span, p")) {
    if (/^(promoted|sponsored)$/i.test((label.textContent ?? "").trim())) return true;
  }
  const text = post.textContent ?? "";
  if (/\bPromoted\b|\bSponsored\b/.test(text.slice(0, 400))) return true;
  return post.querySelector("[aria-label*='promoted' i]") !== null;
}

/** Like-button selectors, shared by findLikeButton + the findFeedPosts fallback
 * so the "which button is a Like" definition never drifts between the two. */
export const LIKE_BUTTON_SELECTORS = [
  // Current LinkedIn feed (2026): the react/like toggle is labelled by its STATE,
  // e.g. "Reaction button state: no reaction" (unliked) or "Reaction button state:
  // like" (already reacted) — and it no longer carries aria-pressed. This prefix
  // must NOT match the separate "Open reactions menu" affordance.
  "button[aria-label^='Reaction button state' i]",
  "button[aria-label*='Reaction button state' i]",
  // Legacy labels (older feed variants) — kept for resilience.
  "button[aria-label^='React Like' i]",
  "button[aria-label*='React Like' i]",
  "button[aria-label*='Like' i][aria-pressed]",
];

export function findLikeButton(post: Element): HTMLElement | null {
  for (const sel of LIKE_BUTTON_SELECTORS) {
    const el = post.querySelector<HTMLElement>(sel);
    if (el) return el;
  }
  return null;
}

export function isAlreadyLiked(post: Element): boolean {
  const btn = findLikeButton(post);
  if (!btn) return false;
  const al = btn.getAttribute("aria-label") ?? "";
  // Current markup encodes the reaction state in the label: "…: no reaction" is
  // NOT liked; any other state ("…: like", "…: celebrate", …) is already reacted.
  if (/reaction button state:/i.test(al)) return !/no reaction/i.test(al);
  // Legacy: the React Like button exposed aria-pressed.
  return btn.getAttribute("aria-pressed") === "true";
}

// The reaction flyout that LinkedIn reveals on a hover/long-press of the Like
// button — a small row of the six reaction buttons (Like/Celebrate/Support/
// Love/Insightful/Funny). Present in the DOM only while open. Broadest-last.
export const REACTIONS_MENU_SELECTORS = [
  ".reactions-menu",
  "[class*='reactions-menu']",
  "[class*='reactions-menu-container']",
];

/** The open reaction flyout, or null when it isn't showing. */
export function findReactionsMenu(root: ParentNode): HTMLElement | null {
  for (const sel of REACTIONS_MENU_SELECTORS) {
    const el = root.querySelector<HTMLElement>(sel);
    if (el) return el;
  }
  return null;
}

/**
 * The flyout button for one reaction, or null. Resolution order, most- to
 * least- drift-resistant:
 *   1. `[data-reaction-type='PRAISE']` — the Voyager enum LinkedIn stamps on
 *      each reaction button; survives class/label churn.
 *   2. inside the open reactions menu, a button whose aria-label / text carries
 *      the visible word ("Celebrate", "Support"). The action-bar Like *toggle*
 *      (aria-label "…to Jane's post") is excluded so a label match can't grab it
 *      instead of the flyout item.
 * `type` is the Voyager enum; `label` is its visible word (see lib/reactions).
 */
export function findReactionButton(root: ParentNode, type: string, label: string): HTMLElement | null {
  const byData = root.querySelector<HTMLElement>(`[data-reaction-type='${type}' i]`);
  if (byData) return (byData.closest<HTMLElement>("button") ?? byData);

  const menu = findReactionsMenu(root);
  if (menu) {
    const word = new RegExp(`\\b${label}\\b`, "i");
    for (const b of Array.from(menu.querySelectorAll<HTMLElement>("button"))) {
      const al = b.getAttribute("aria-label") ?? "";
      if (/'s post/i.test(al)) continue; // the action-bar toggle, not a flyout item
      if (word.test(al) || word.test(b.textContent ?? "")) return b;
    }
  }
  return null;
}

// The messaging overlay (chat bubbles) persists across navigations and holds a
// type=submit "Send" button + its own contenteditable. The comment flow must
// never touch it: a comment typed into a chat pane and "submitted" there is a
// PRIVATE MESSAGE to an arbitrary contact that clears the pane — which the
// posted-check would read as success. The box search, the box anchor, and
// every submit candidate pass all reject anything inside it.
export const MESSAGING_SEL = ".msg-form, [class*='msg-overlay']";

export function findCommentBox(root: ParentNode): HTMLElement | null {
  // Never a messaging textbox: the chat overlay persists across navigations
  // and holds its own contenteditable — typing a comment there (or confirming
  // against it) targets a private DM pane, not the post's composer. Skipping
  // (rather than failing) keeps commenting alive even if LinkedIn mounts the
  // overlay before the main content in the DOM. The aria check backs up the
  // class check: messaging classes could be obfuscated like the feed's were,
  // but the pane's accessible name ("Write a message…") names its purpose —
  // while the comment editor's never contains "message" on either era.
  const notMessaging = (el: HTMLElement) =>
    el.closest(MESSAGING_SEL) === null && !/message/i.test(el.getAttribute("aria-label") ?? "");

  // Current permalink markup gives the post composer a stable component key,
  // while the editor below it no longer always serializes as
  // contenteditable="true". It can use plaintext-only or expose only the
  // textbox role while editability is inherited. Scope those broader shapes
  // to commentBox-* so another page textbox cannot become a comment target.
  for (const anchor of root.querySelectorAll<HTMLElement>("[componentkey^='commentBox-']")) {
    const candidates = [
      ...(anchor.matches("[contenteditable], [role='textbox']") ? [anchor] : []),
      ...Array.from(anchor.querySelectorAll<HTMLElement>("[contenteditable], [role='textbox']")),
    ];
    const editor = candidates.find((el) =>
      el.getAttribute("contenteditable")?.trim().toLowerCase() !== "false" && notMessaging(el));
    if (editor) return editor;
  }

  return (
    Array.from(root.querySelectorAll<HTMLElement>("div[role='textbox'][contenteditable='true']")).find(notMessaging) ??
    Array.from(root.querySelectorAll<HTMLElement>(".comments-comment-box [contenteditable='true']")).find(notMessaging) ??
    null
  );
}

/** Strip invisible rich-editor residue before comparing or reading its body. */
export function normalizeEditorText(text: string): string {
  return text.replace(/[\u200B\uFEFF]/g, "").trim();
}

/**
 * The current text inside the comment composer, trimmed (zero-width spaces the
 * editor leaves are stripped). Returns null when there is no composer at all.
 * The background reads this after a submit to CONFIRM the comment landed:
 * LinkedIn clears the composer on a successful post, so a still-populated box
 * means the comment did NOT go through (an off-viewport button the click missed,
 * or a submit that never fired).
 */
export function commentBoxText(root: ParentNode): string | null {
  const box = findCommentBox(root);
  if (!box) return null;
  // Strip zero-width space / BOM the rich editor can leave behind, so an
  // otherwise-cleared box reads as empty.
  return normalizeEditorText(box.textContent ?? "");
}

// ── Comment submit ──────────────────────────────────────────────────────────
// The 2026 redesign broke every unanchored way of finding the submit: class
// names are obfuscated hashes (no BEM), the action-bar comment TOGGLE was
// relabeled from "Comment on <name>'s post" to bare "Comment" (killing the
// possessive exclusion), and the toggle PRECEDES the composer in document
// order — so a document-wide word scan returned the toggle, the background
// clicked it once, nothing posted, and every attempt logged
// comment-failed:not-cleared. The search is now ANCHORED to the composer box
// and a decoy can only lose: if nothing qualifies we return null, which keeps
// the background's 6s poll waiting (correct for the 2026 submit, disabled
// until typing registers) and ends in a diagnosable submit-not-found instead
// of a wrong click.

const SUBMIT_WORD = /^(post comment|comment|post|reply)$/i;
const isSubmitWord = (s: string) => SUBMIT_WORD.test(s.trim());

/** Exact-word match on aria-label OR text. The 2026 toggle's textContent is
 * label + count span ('Comment10' — misses the word list) but its aria-label
 * 'Comment' hits; toggles are rejected by the exclusions below, never by
 * hoping the count span breaks the word match. */
function submitWordy(el: HTMLElement): boolean {
  return isSubmitWord(el.getAttribute("aria-label") ?? "") || isSubmitWord(el.textContent ?? "");
}

/** Submit-styled: legacy primary/BEM classes, or an explicit type=submit (the
 * migrated FEED composer carries it; the post-permalink surface may not, so
 * primary is never REQUIRED on the anchored pass). */
function submitPrimary(el: HTMLElement): boolean {
  return /artdeco-button--primary|__submit-button/i.test(el.className) || el.getAttribute("type") === "submit";
}

/** The action-bar comment TOGGLE (opens the composer, never posts). Legacy
 * kept a possessive label; the 2026 toggle is bare "Comment" and is identified
 * by its SDUI hooks instead — data-view-name, the componentkey button-section
 * wrapper, and the comment-small sprite icon. All cheap, checked defensively
 * in parallel so partial markup drift doesn't reopen the decoy channel. */
function toggleLike(el: HTMLElement): boolean {
  if (/on .+'s post/i.test(el.getAttribute("aria-label") ?? "")) return true;
  if (el.getAttribute("data-view-name") === "feed-comment-button") return true;
  // The action-bar toggle carries the comment-bubble sprite (svg#comment-small).
  // The composer SUBMIT does NOT — its label is the word "Comment" as text. This
  // is the reliable discriminator on the live 2026 permalink.
  //
  // NOTE: do NOT treat `componentkey*="commentButtonSection"` as a toggle
  // signal. The live DOM proves the opposite — `commentButtonSection` is the
  // wrapper around the real composer SUBMIT, so excluding it (as this code once
  // did) discarded the very button we needed and produced the wf=0 wall.
  if (el.querySelector("svg #comment-small, svg[id='comment-small'], use[href*='comment-small']") !== null) return true;
  // Shape check: a button that is wordy only via aria-label while its visible
  // content is just a count ("10", "1,024", "1.2K") is the action-bar
  // affordance — the real submit shows the word itself, never a count.
  const ownText = (el.textContent ?? "").trim();
  return /^\d[\d,.]*[kKmM]?$/.test(ownText) && isSubmitWord(el.getAttribute("aria-label") ?? "");
}

// Thread reply affordances live inside per-comment items on both eras (2026
// SDUI wraps each in [componentkey^=replaceableComment]; legacy uses
// comments-comment-item/-entity classes). The composer submit never does —
// this is what keeps enabled bare "Reply" buttons out of every pass. But the
// live 2026 capture shows the wrappers are NOT guaranteed (its reply affordance
// sits in a plain .comments-section div), so bare "Reply" is additionally
// rejected by anchoredWordy below unless the button is submit-styled.
const COMMENT_ITEM_SEL =
  "[componentkey^='replaceableComment'], [class*='comments-comment-item'], [class*='comments-comment-entity']";

function submitDisabled(el: HTMLElement): boolean {
  // `.disabled` only exists on real <button>s; aria-disabled covers role=button.
  return (el as HTMLButtonElement).disabled === true || el.getAttribute("aria-disabled") === "true";
}

/** Shared candidate filter for every pass: a real (or ARIA) button that is
 * enabled, not the action-bar toggle, not part of an existing comment, and
 * not inside the messaging overlay. */
function submitEligible(el: HTMLElement): boolean {
  if (submitDisabled(el)) return false;
  if (toggleLike(el)) return false;
  if (el.closest(MESSAGING_SEL) !== null) return false;
  return el.closest(COMMENT_ITEM_SEL) === null;
}

function submitCandidates(scope: ParentNode): HTMLElement[] {
  return Array.from(scope.querySelectorAll<HTMLElement>("button, [role='button']")).filter(submitEligible);
}

/** Word-gate for the anchored pass. Mandatory — submit-styling (type=submit /
 * primary classes) is only ever a TIEBREAKER, never a qualifier on its own,
 * because the chat overlay's Send button is type=submit: without the word
 * requirement the climb could hand a comment to a private-message pane. Bare
 * "Reply" is the label of thread reply affordances (hook-less on live 2026
 * captures), never the main composer's submit, so it only qualifies when the
 * button is also submit-styled. */
function anchoredWordy(el: HTMLElement): boolean {
  if (!submitWordy(el)) return false;
  const bareReply =
    /^reply$/i.test((el.getAttribute("aria-label") ?? "").trim()) ||
    /^reply$/i.test((el.textContent ?? "").trim());
  return !bareReply || submitPrimary(el);
}

export interface CommentSubmitHit {
  el: HTMLElement;
  /** Which pass found it (composer:<hops> | bem | global-primary) — rides
   * locateCommentSubmit's observed.via into the failure diagnostics. */
  via: string;
}

export function findCommentSubmitInfo(root: ParentNode): CommentSubmitHit | null {
  // findCommentBox never returns a messaging textbox, so the anchor — like
  // every candidate below — is guaranteed to live outside the chat overlay.
  const box = findCommentBox(root);

  // 1) Composer-anchored: climb from the box up to 6 ancestors and take the
  //    FIRST level that yields a candidate. A candidate must FOLLOW the box in
  //    document order (the submit renders after the editor, the action-bar
  //    toggle precedes it — position has survived every redesign) and be either
  //    WORDY (anchoredWordy) or an explicit `type=submit`. The type=submit
  //    branch is what catches the 2026 permalink's ICON-ONLY submit (live rows
  //    showed wf=0 / all>0 — a composer with worded buttons only for the toggle,
  //    and the real submit carrying no submit word). It is safe because the DM
  //    "Send" (also type=submit) is already excluded by MESSAGING_SEL, toggles
  //    by toggleLike, and thread replies by COMMENT_ITEM_SEL; a wrong click here
  //    can at worst not-clear (recoverable), never send a DM. Worded still wins
  //    the tiebreak, so legacy/worded surfaces behave exactly as before. Never
  //    widen past a hit, and stop at a <form>. A level holding only a DISABLED
  //    would-be submit returns null (wait for enable; widening would reach
  //    decoys).
  if (box) {
    const follows = (el: HTMLElement) =>
      (box.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
    // An icon-only / non-worded submit qualifies only via an explicit
    // type=submit AND only when its accessible name isn't a DIFFERENT action —
    // 'Send'/'Message'/'Connect'/… are type=submit buttons that must never be
    // clicked by the comment flow (the DM Send especially). This keeps the
    // icon-only comment submit reachable without reopening the send channel even
    // if messaging classes get obfuscated out of MESSAGING_SEL.
    const NONCOMMENT = /\b(send|message|invite|connect|follow|unfollow|share|repost|save|submit cv|apply)\b/i;
    const commentSubmitTyped = (el: HTMLElement) => {
      if (el.getAttribute("type") !== "submit") return false;
      const name = `${el.getAttribute("aria-label") ?? ""} ${el.textContent ?? ""}`;
      return !NONCOMMENT.test(name);
    };
    const wanted = (el: HTMLElement) =>
      (anchoredWordy(el) || commentSubmitTyped(el)) && follows(el) && !toggleLike(el) &&
      el.closest(COMMENT_ITEM_SEL) === null && el.closest(MESSAGING_SEL) === null;
    let scope: HTMLElement | null = box.parentElement;
    for (let hops = 1; scope && hops <= 6; hops++) {
      const wouldBe = Array.from(scope.querySelectorAll<HTMLElement>("button, [role='button']")).filter(wanted);
      const enabled = wouldBe.filter((el) => !submitDisabled(el));
      if (enabled.length > 0) {
        // Prefer worded, then explicit type=submit, then primary-styled;
        // querySelectorAll order keeps first-in-document among equals.
        const score = (el: HTMLElement) =>
          (anchoredWordy(el) ? 4 : 0) + (el.getAttribute("type") === "submit" ? 2 : 0) + (submitPrimary(el) ? 1 : 0);
        const best = enabled.reduce((a, b) => (score(b) > score(a) ? b : a));
        return { el: best, via: `composer:${hops}` };
      }
      if (wouldBe.length > 0) return null; // disabled submit at this level: wait, never widen
      if (scope.tagName === "FORM") break;
      scope = scope.parentElement;
    }
  }

  // 2) Legacy BEM submit (state suffixes like __submit-button--cr) — but only
  //    when it passes the filter: the old unconditional pass-0 returned a
  //    DISABLED BEM submit and the click silently no-oped.
  for (const el of Array.from(root.querySelectorAll<HTMLElement>("button[class*='comments-comment-box__submit-button']"))) {
    if (submitEligible(el)) return { el, via: "bem" };
  }

  // 3) Global scan, but only wordy AND submit-styled — and when a composer box
  //    exists the hit must FOLLOW it in document order (the submit always
  //    renders after the editor; the toggle always precedes it). There is
  //    deliberately NO bare global word pass anymore — that was the proven
  //    toggle-hijack channel.
  for (const el of submitCandidates(root)) {
    if (!(submitWordy(el) && submitPrimary(el))) continue;
    if (box && !(box.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING)) continue;
    return { el, via: "global-primary" };
  }
  return null;
}

export function findCommentSubmit(root: ParentNode): HTMLElement | null {
  return findCommentSubmitInfo(root)?.el ?? null;
}

export interface SubmitSearchDiag {
  /** a composer box was found at all */
  box: boolean;
  /** buttons that are submit-WORDED, FOLLOW the box, and aren't a
   * toggle/comment-item/messaging button — the exact pool the anchored/global
   * passes draw from. */
  wf: number;
  /** of `wf`, how many are enabled */
  en: number;
  /** of the enabled ones, how many have a non-zero layout rect (a click could
   * actually land) — `en>0, vis=0` means the submit exists and is enabled but
   * has no box yet (the locator's zero-rect skip fires). */
  vis: number;
  /** any button whose aria/text is a submit word anywhere on the page,
   * including the toggle and thread replies — a floor on "does a 'Comment'-ish
   * button even exist on this surface". */
  all: number;
  /** the most informative candidate + WHY it was rejected, as
   * `<label>_<dis|zr|pre|tog|itm|msg|nobox|ok>`. */
  top: string;
  /** compact dump of the buttons in/around the composer (the 6-hop climb region
   * plus any worded button), each as
   * `<label>_<pos><type>_<disabled><zerorect><worded>_g<group>` —
   *   pos:  f=follows box, p=precedes, n=no box
   *   type: s=submit, b=button, x=other/none
   *   group: t=toggle, i=comment-item, m=messaging, n=none
   * This shows the REAL submit's shape even when it's icon-only (worded=0) or
   * mis-ordered — the thing the counts alone can't reveal. Space-separated so it
   * survives the reason sanitizer. */
  region: string;
  /** the composer editor + real submit, to answer WHY the submit stays disabled
   * with text present:
   *   bx=<tag>.<cls>  the box findCommentBox typed into
   *   al=<aria>       its aria-label (should be "…creating comment")
   *   pm=<0/1>        is it inside a ProseMirror/TipTap editor?
   *   len=<n>         box.textContent length (did our text land here?)
   *   nce=<n>         how many contenteditables on the page (wrong-box risk)
   *   sub=<cls>       the type=submit button's classes
   *   ad=<v>          its aria-disabled
   *   dis=<v>         its .disabled property
   * If pm=1,len>0 but dis=true, the editor has our text in the DOM but not its
   * model. If pm=0 or nce>1, we may be typing into the wrong node. */
  dom: string;
}

/**
 * Why did findCommentSubmitInfo return null? `submit-not-found` collapses three
 * very different failures — no worded submit exists, one exists but stays
 * disabled the whole poll, one is enabled but has no layout box (the zero-rect
 * skip) — into a single reason. This re-walks the same predicates and counts
 * each bucket so a failure row in linkedin_activity says WHICH, without a live
 * DevTools session (unavailable during a run). `isZeroRect` is injected: the
 * content script measures real rects, tests stub it. Read-only, no side effects.
 */
export function diagnoseCommentSubmit(
  root: ParentNode,
  isZeroRect: (el: HTMLElement) => boolean,
): SubmitSearchDiag {
  const box = findCommentBox(root);
  const buttons = Array.from(root.querySelectorAll<HTMLElement>("button, [role='button']"));
  const worded = buttons.filter(submitWordy);
  const follows = (el: HTMLElement) =>
    !!box && (box.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
  const wf = worded.filter(
    (el) => follows(el) && !toggleLike(el) && el.closest(COMMENT_ITEM_SEL) === null && el.closest(MESSAGING_SEL) === null,
  );
  const en = wf.filter((el) => !submitDisabled(el));
  const vis = en.filter((el) => !isZeroRect(el));
  const label = (el: HTMLElement) => ((el.getAttribute("aria-label") || el.textContent) ?? "").trim().slice(0, 12);
  const why = (el: HTMLElement): string =>
    !box ? "nobox"
      : submitDisabled(el) ? "dis"
      : !follows(el) ? "pre"
      : toggleLike(el) ? "tog"
      : el.closest(COMMENT_ITEM_SEL) ? "itm"
      : el.closest(MESSAGING_SEL) ? "msg"
      : isZeroRect(el) ? "zr"
      : "ok";
  // Name the most telling candidate, in priority of what best explains the
  // failure: an enabled-but-invisible one (locator saw it, skipped on zero rect
  // → `zr`), then a disabled would-be submit (never enabled → `dis`), then a
  // healthy enabled+visible one (`ok` — it SHOULD have been clicked, so a real
  // locator logic bug), then any worded button whose `why` reveals what
  // excluded it (the only "Comment" is the action-bar toggle → `tog`/`pre`).
  const pick = en.find(isZeroRect) ?? wf.find(submitDisabled) ?? vis[0] ?? worded[0];

  // Region dump: every button within the box's 6-hop climb scope (where the
  // real submit must live if the locator is to find it) plus any worded button
  // elsewhere (the toggles). Names each button's shape so an icon-only or
  // mis-ordered real submit is visible in the failure row.
  let region: ParentNode = root;
  if (box) {
    let s: HTMLElement = box;
    for (let i = 0; i < 6 && s.parentElement; i++) s = s.parentElement;
    region = s;
  }
  const near = new Set<HTMLElement>(Array.from(region.querySelectorAll<HTMLElement>("button, [role='button']")));
  for (const w of worded) near.add(w);
  // Also every type=submit document-wide — if the real submit sits outside the
  // 6-hop climb region or precedes the box, it must still surface in the dump.
  for (const s of Array.from(root.querySelectorAll<HTMLElement>("button[type='submit'], [role='button'][type='submit']"))) near.add(s);
  const typeChar = (el: HTMLElement) => {
    const t = el.getAttribute("type");
    return t === "submit" ? "s" : t === "button" ? "b" : "x";
  };
  const groupChar = (el: HTMLElement) =>
    toggleLike(el) ? "t" : el.closest(COMMENT_ITEM_SEL) ? "i" : el.closest(MESSAGING_SEL) ? "m" : "n";
  const token = (el: HTMLElement) =>
    `${label(el).slice(0, 10)}_${box ? (follows(el) ? "f" : "p") : "n"}${typeChar(el)}_` +
    `${submitDisabled(el) ? 1 : 0}${isZeroRect(el) ? 1 : 0}${submitWordy(el) ? 1 : 0}_g${groupChar(el)}`;
  const region_ = Array.from(near).slice(0, 8).map(token).join(" ");

  // Composer/editor descriptor — the ground truth for a disabled submit while
  // text is present. Uses only sanitizer-safe chars ([A-Za-z0-9 _-]); class
  // names are hashed on 2026 surfaces, so a short fingerprint only — the
  // booleans (pm/len/nce, ad/dis) carry the signal. Tokens are `key_value`,
  // space-separated.
  const safe = (s: string, n: number) => s.replace(/\s+/g, "-").replace(/[^A-Za-z0-9_-]/g, "").slice(0, n);
  const clsF = (el: Element | null) => (el ? safe((el.className || "").toString(), 16) || "x" : "x");
  // Describe the button the locator actually resolves to (or the first
  // submit-worded following candidate when it resolves to none) — NOT merely the
  // first type=submit on the page, which on LinkedIn is often an unrelated
  // element (e.g. the Grammarly overlay's hidden submit).
  const sub =
    findCommentSubmitInfo(root)?.el ??
    (box ? worded.find((el) => follows(el)) : undefined) ??
    null;
  const nce = root.querySelectorAll("[contenteditable='true']").length;
  const pmBox = box?.closest(".ProseMirror, .tiptap, [data-testid*='tiptap' i], [data-testid*='editor' i]") ?? null;
  const dom = box
    ? `bx_${box.tagName.toLowerCase()} cls_${clsF(box)} al_${safe(box.getAttribute("aria-label") ?? "", 16) || "none"} ` +
      `pm_${pmBox ? 1 : 0} len_${(box.textContent ?? "").trim().length} nce_${nce} ` +
      (sub ? `sub_${clsF(sub)} ad_${safe(sub.getAttribute("aria-disabled") ?? "na", 6)} dis_${(sub as HTMLButtonElement).disabled}` : "sub_none")
    : `bx_none nce_${nce}`;

  return {
    box: !!box,
    wf: wf.length,
    en: en.length,
    vis: vis.length,
    all: worded.length,
    top: pick ? `${label(pick)}_${why(pick)}` : "none",
    region: region_,
    dom,
  };
}

/**
 * Returns a button that opens a post's comments to READ them, or null. Ambient
 * (read-only) decoy: a human scrolling the feed regularly opens the discussion
 * under a post. Prefers the social-counts "N comments" button — it expands the
 * thread *without* focusing the composer — and falls back to the action-bar
 * "Comment" button. Never returns the composer's "Post comment" submit.
 */
export function findCommentsToggle(post: Element): HTMLElement | null {
  // Primary: the social-counts "12 comments" button — opens the thread to read.
  const counts =
    post.querySelector<HTMLElement>("button.social-details-social-counts__comments") ??
    post.querySelector<HTMLElement>(".social-details-social-counts__comments button") ??
    post.querySelector<HTMLElement>(".social-details-social-counts button[aria-label*='comment' i]");
  if (counts) return counts;

  // Any button whose aria-label reads like a comment count ("12 comments").
  for (const btn of Array.from(post.querySelectorAll<HTMLElement>("button[aria-label]"))) {
    if (/\b\d[\d,]*\s+comments?\b/i.test(btn.getAttribute("aria-label") ?? "")) return btn;
  }

  // Fallback: the action-bar "Comment" button (opens the section + focuses the
  // composer). aria-label starts with "Comment" ("Comment on Jane's post"),
  // which never matches the "Post comment" submit or the "React Like" button.
  return (
    post.querySelector<HTMLElement>(".feed-shared-social-action-bar button[aria-label^='Comment' i]") ??
    post.querySelector<HTMLElement>("button[aria-label^='Comment' i]") ??
    null
  );
}

/** True if the post exposes a comments-open affordance. */
export function hasComments(post: Element): boolean {
  return findCommentsToggle(post) !== null;
}

export function findMessageCompose(root: ParentNode): HTMLElement | null {
