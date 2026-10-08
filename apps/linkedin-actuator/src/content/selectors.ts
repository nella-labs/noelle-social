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
