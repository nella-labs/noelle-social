import { findFeedPosts, isSponsored, postActivityUrn, postText } from "./selectors.js";
import { elementCenter, elementRect, type LocateResult } from "./locators.js";
import { directActivityUrn } from "../lib/urn.js";

export type VisiblePost = {
  fingerprint: string;
  urn?: string;
  url?: string;
  text: string;
  reactionCount?: number;
  commentCount?: number;
  authorName?: string;
  authorHeadline?: string;
  authorHandle?: string;
  authorId?: string;
  postedAt?: string;
};

function cards(root: ParentNode): Element[] {
  const found = new Set(findFeedPosts(root));
  // The live feed now omits activity URNs entirely. Its per-post menu label is
  // still exposed even when every class and component key is obfuscated.
  for (const menu of root.querySelectorAll("button[aria-label^='Open control menu for post by' i]")) {
    const card = menu.closest("[role='listitem']");
    if (card) found.add(card);
  }
  return [...found];
}

function inViewport(post: Element): boolean {
  if (typeof window === "undefined") return true;
  if (window.getComputedStyle(post).display === "none") return false;
  const rect = post.getBoundingClientRect();
  return post.getClientRects().length === 0 || !(rect.bottom < 0 || rect.top > window.innerHeight);
}

function readableText(el: Element): string {
  // innerText keeps the line breaks in the current expandable text span. jsdom
  // has no innerText, so tests use an equivalent walk over text and <br> nodes.
  const rendered = (el as HTMLElement).innerText;
  if (typeof rendered === "string") return normalizeText(rendered);
  let result = "";
  const walk = (node: Node): void => {
    if (node.nodeType === Node.TEXT_NODE) { result += node.textContent ?? ""; return; }
    if (node instanceof Element && node.tagName === "BR") { result += "\u0000"; return; }
    for (const child of node.childNodes) walk(child);
  };
  walk(el);
  return result.split("\u0000")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean).join("\n");
}

function normalizeText(value: string): string {
  return value.replace(/\r/g, "").split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean).join("\n");
}

function fingerprint(author: string, body: string): string {
  let hash = 0xcbf29ce484222325n;
  for (const char of `${author.toLowerCase()}\u0000${body.replace(/\s+/g, " ").trim()}`) {
    hash ^= BigInt(char.codePointAt(0)!);
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return `v1-${hash.toString(16).padStart(16, "0")}`;
}

function engagementCount(post: Element, word: "reactions" | "comments"): number {
  const noun = word === "reactions" ? "reactions?" : "comments?";
  const pattern = new RegExp(`^([\\d,.]+(?:[kKmM])?)\\s+${noun}$`, "i");
  const parseCount = (raw: string): number | null => {
    const number = raw.replace(/,/g, "");
    const size = /[kKmM]$/.test(number) ? (/k$/i.test(number) ? 1000 : 1_000_000) : 1;
    const parsed = Number.parseFloat(number) * size;
    return Number.isFinite(parsed) ? Math.round(parsed) : null;
  };
  for (const node of post.querySelectorAll("span, a, button")) {
    if (node.getAttribute("aria-hidden") === "true") continue;
    const label = (node.getAttribute("aria-label") ?? node.textContent ?? "").trim();
    const match = label.match(pattern);
    if (match) {
      const count = parseCount(match[1]!);
      if (count !== null) return count;
    }
    // Current feed names one reactor and then counts the others. The second
    // copy of that label is aria-hidden and must not be counted separately.
    if (word === "reactions") {
      const named = label.match(/^.+\s+and\s+([\d,.]+(?:[kKmM])?)\s+others?\s+reacted$/i);
      if (named) {
        const others = parseCount(named[1]!);
        if (others !== null) return others + 1;
      }
    }
  }
  return 0;
}

function publishedAt(post: Element, now: Date): string | undefined {
  const time = post.querySelector("time[datetime], time[title], time");
  const exact = time?.getAttribute("datetime") ?? time?.getAttribute("title");
  if (exact) {
    const date = new Date(exact);
    if (Number.isFinite(date.getTime())) return date.toISOString();
  }
  const topLike = post.querySelector("button[aria-label^='Reaction button state' i]");
  const relativeText = time?.textContent ??
    Array.from(post.querySelectorAll("p")).find((p) =>
      (!topLike || Boolean(p.compareDocumentPosition(topLike) & Node.DOCUMENT_POSITION_FOLLOWING)) &&
      /^\s*\d+\s*[mhdw]\b/i.test(p.textContent ?? ""))?.textContent;
  const relative = (relativeText ?? "").trim().match(/^(\d+)\s*(m|h|d|w)\b/i);
  if (!relative) return undefined;
  const size = { m: 60_000, h: 3600_000, d: 24 * 3600_000, w: 7 * 24 * 3600_000 }[relative[2]!.toLowerCase() as "m" | "h" | "d" | "w"];
  return new Date(now.getTime() - Number(relative[1]) * size).toISOString();
}

function visibleBodyText(post: Element): string {
  const primary = post.querySelector("[data-testid='expandable-text-box'], .update-components-text");
  if (primary) {
    const body = readableText(primary);
    // In the current feed, the full body is already in this span. The More
    // button only changes the clamp and appends its own label to innerText.
    const more = primary.querySelector("[data-testid='expandable-text-button']");
    const label = more ? readableText(more) : "";
    return label && body.endsWith(label) ? normalizeText(body.slice(0, -label.length)) : body;
  }
  if (post.querySelector("[data-sdui-anchor-id^='feed-header-urn:li:activity:']")) {
    const topLike = post.querySelector("button[aria-label^='Reaction button state' i]");
    const paragraphs = Array.from(post.querySelectorAll("p")).filter((p) =>
      !topLike || Boolean(p.compareDocumentPosition(topLike) & Node.DOCUMENT_POSITION_FOLLOWING));
    const timeIndex = paragraphs.findIndex((p) => /^\s*\d+\s*[mhdw]\b/i.test(p.textContent ?? ""));
    if (timeIndex >= 0) {
      const body = paragraphs.slice(timeIndex + 1).find((p) => {
        const value = (p.textContent ?? "").trim();
        return value.length > 0 && !/^\d+\s+(reactions?|comments?|reposts?)\b/i.test(value);
      });
      if (body) return readableText(body);
    }
  }
  return postText(post).trim();
}

function observation(post: Element, now: Date): VisiblePost | null {
  if (isSponsored(post) || !inViewport(post)) return null;
  const menu = post.querySelector("button[aria-label^='Open control menu for post by' i]");
  const rawUrn = postActivityUrn(post)
    ?? post.getAttribute("data-id")
    // A current card can cite another LinkedIn post in its body. Its own
    // identity comes from the menu only after Jev qualifies it.
    ?? (menu ? null : post.querySelector("a[href*='activity-'], a[href*='urn:li:activity:']")?.getAttribute("href"))
    ?? "";
  const id = /activity[-:](\d{10,})/i.exec(rawUrn)?.[1];
  const urn = id ? `urn:li:activity:${id}` : undefined;
  // Anonymous cards must expose a control menu so a qualified post can later
  // be resolved to a canonical identity without opening every post.
  if (!urn && !menu) return null;
  const text = visibleBodyText(post);
  if (!text) return null;
  const menuName = post.querySelector("button[aria-label^='Open control menu for post by' i]")
    ?.getAttribute("aria-label")?.replace(/^Open control menu for post by\s+/i, "").trim();
  const authorLink = Array.from(post.querySelectorAll<HTMLAnchorElement>("a[href*='/in/']"))
    .find((anchor) => menuName && (anchor.textContent ?? "").toLowerCase().includes(menuName.toLowerCase()))
    ?? post.querySelector<HTMLAnchorElement>("a[href*='/in/']");
  const authorHandle = authorLink?.getAttribute("href")?.match(/\/in\/([^/?#]+)/)?.[1];
  const authorName = (menuName ?? post.querySelector(".update-components-actor__name")?.textContent ?? authorLink?.textContent ?? "").trim();
  const headline = post.querySelector(".update-components-actor__description")?.textContent?.trim();
  const date = publishedAt(post, now);
  return {
    fingerprint: fingerprint(authorHandle ?? authorName, text),
    ...(urn ? { urn, url: permalink(post, urn) } : {}),
    text,
    reactionCount: engagementCount(post, "reactions"),
    commentCount: engagementCount(post, "comments"),
    ...(authorName ? { authorName } : {}),
    ...(authorHandle ? { authorHandle } : {}),
    ...(headline ? { authorHeadline: headline } : {}),
    ...(date ? { postedAt: date } : {}),
  };
}

function permalink(post: Element, urn: string): string {
  for (const anchor of post.querySelectorAll<HTMLAnchorElement>("a[href*='activity-'], a[href*='urn:li:activity:']")) {
    const raw = anchor.getAttribute("href");
    if (!raw) continue;
    try {
      const url = new URL(raw, "https://www.linkedin.com");
      if (url.hostname === "www.linkedin.com" && url.pathname.includes(urn.split(":").at(-1)!)) return url.toString();
    } catch { /* malformed link; use canonical URN URL */ }
  }
  return `https://www.linkedin.com/feed/update/${urn}/`;
}

/** Read currently rendered cards on feed, profile activity, and content search. */
export function harvestVisiblePosts(root: ParentNode, now = new Date()): VisiblePost[] {
  const out = new Map<string, VisiblePost>();
  for (const post of cards(root)) {
    const item = observation(post, now);
    if (!item) continue;
    const key = item.urn ?? item.fingerprint;
    if (out.has(key)) continue;
    out.set(key, item);
    if (out.size === 50) break;
  }
  return [...out.values()];
}

// The menu's DOM can be portaled outside its card. Keep the button selected by
// the last locate request so a failed menu read can describe that exact action.
let selectedDiscoveryMenuButton: Element | null = null;
let menuButtonWasExpanded = false;
let visibleMenusBeforeClick: Set<Element> | null = null;
let visibleCopyBeforeClick: Set<Element> | null = null;
let shadowCopyBeforeClick: Set<Element> | null = null;

/** The same fingerprint as harvestVisiblePosts, measured only for complete cards. */
export function locateDiscoveryPostMenu(root: ParentNode, targetFingerprint: string): LocateResult {
  selectedDiscoveryMenuButton = null;
  visibleMenusBeforeClick = null;
  visibleCopyBeforeClick = null;
  shadowCopyBeforeClick = null;
  for (const card of cards(root)) {
    const item = observation(card, new Date());
    if (item?.fingerprint !== targetFingerprint) continue;
    const button = card.querySelector<HTMLElement>("button[aria-label^='Open control menu for post by' i]");
    if (!button) return { ok: false, skipReason: "post-menu-not-found" };
    button.scrollIntoView?.({ block: "center" });
    const rect = elementRect(button);
    if (rect.width <= 0 || rect.height <= 0) return { ok: false, skipReason: "post-menu-zero-rect" };
    selectedDiscoveryMenuButton = button;
    menuButtonWasExpanded = button.getAttribute("aria-expanded") === "true";
    visibleMenusBeforeClick = new Set(deepElements(root, "[role='menu']")
      .filter((menu) => visibleMenuElement(menu) && inViewport(menu)));
    visibleCopyBeforeClick = new Set([...visibleMenusBeforeClick].flatMap(copyLinkLeaves));
    const shadow = root.querySelector("#interop-outlet")?.shadowRoot;
    shadowCopyBeforeClick = new Set(shadow ? copyLinkLeaves(shadow) : []);
    return { ok: true, ...elementCenter(button), rect };
  }
  return { ok: false, skipReason: "qualified-post-not-visible" };
}

const diagnosticTags = new Set(["a", "button", "div", "li", "span"]);
const diagnosticRoles = new Set(["menu", "menuitem", "button", "dialog"]);

function deepElements(root: ParentNode, selector: string): Element[] {
  const found: Element[] = [];
  const walk = (scope: ParentNode): void => {
    for (const element of scope.querySelectorAll("*")) {
      if (element.matches(selector)) found.push(element);
      if (element.shadowRoot) walk(element.shadowRoot);
    }
  };
  walk(root);
  return found;
}

function composedParent(element: Element): Element | null {
  const parent: Element | null = element.parentElement;
  const boundary = element.getRootNode();
  return parent ?? (boundary instanceof ShadowRoot ? boundary.host : null);
}

function visibleMenuElement(element: Element): boolean {
  for (let node: Element | null = element; node; node = composedParent(node)) {
    if (node.hasAttribute("hidden") || node.getAttribute("aria-hidden") === "true") return false;
    if (typeof window !== "undefined") {
      const style = window.getComputedStyle(node);
      if (style.display === "none" || style.visibility === "hidden") return false;
    }
  }
  return true;
}

function insideComposedTree(element: Element, ancestor: Element): boolean {
  for (let node: Element | null = element; node; node = composedParent(node)) {
    if (node === ancestor) return true;
  }
  return false;
}

function newlyOpenedOutsideMenus(root: ParentNode): Element[] {
  const selected = selectedDiscoveryMenuButton;
  if (!(root instanceof Element) || !selected || !root.contains(selected) ||
      menuButtonWasExpanded || !visibleMenusBeforeClick) return [];
  const outlet = root.querySelector("#interop-outlet");
  return deepElements(root, "[role='menu']").filter((menu) =>
    !visibleMenusBeforeClick!.has(menu) && visibleMenuElement(menu) && inViewport(menu) &&
    !(outlet && insideComposedTree(menu, outlet)));
}

function newlyOpenedShadowMenus(root: ParentNode): Element[] {
  const outlet = root.querySelector("#interop-outlet");
  const shadow = outlet?.shadowRoot;
  if (!shadow || !selectedDiscoveryMenuButton || menuButtonWasExpanded ||
      !visibleMenusBeforeClick || !(root instanceof Element) ||
      !root.contains(selectedDiscoveryMenuButton)) return [];
  return deepElements(shadow, "[role='menu']").filter((menu) =>
    !visibleMenusBeforeClick!.has(menu) && visibleMenuElement(menu) && inViewport(menu));
}

function saveActionLeaves(menu: ParentNode): Element[] {
  return deepElements(menu, "a, button, div, li, p, span, [role='menuitem'], [role='button']")
    .filter((item) => visibleMenuElement(item) && inViewport(item) &&
      /\b(?:un)?save\b/i.test(`${item.getAttribute("aria-label") ?? ""} ${item.textContent ?? ""}`) &&
      !Array.from(item.children).some((child) => /\b(?:un)?save\b/i.test(child.textContent ?? "")));
}

function hasSaveAction(menu: ParentNode): boolean { return saveActionLeaves(menu).length > 0; }

function copyLinkLeaves(menu: ParentNode): Element[] {
  return deepElements(menu, "a, button, div, li, p, span, [role='menuitem'], [role='button']")
    .filter((element) => visibleMenuElement(element) && inViewport(element) &&
      /^\s*copy\s+(?:(?:this|the|a|post)\s+)?(?:link|url)(?:\s+to\s+.+)?\s*$/i
        .test(`${element.getAttribute("aria-label") ?? ""} ${element.textContent ?? ""}`.trim()) &&
      !Array.from(element.children).some((child) => /\bcopy\s+(?:link|url)\b/i.test(child.textContent ?? "")));
}

function updatedVisibleMenus(root: ParentNode): Element[] {
  if (!(root instanceof Element) || !selectedDiscoveryMenuButton ||
      !root.contains(selectedDiscoveryMenuButton) || menuButtonWasExpanded ||
      selectedDiscoveryMenuButton.getAttribute("aria-expanded") !== "true" ||
      !visibleMenusBeforeClick || !visibleCopyBeforeClick) return [];
  // LinkedIn can reuse a visible role=menu portal and replace its action
  // children. The matched button expanding plus a newly visible Copy action
  // inside one Save menu is the association; an old Copy action is not enough.
  return deepElements(root, "[role='menu']").filter((menu) =>
    visibleMenusBeforeClick!.has(menu) && visibleMenuElement(menu) && inViewport(menu) &&
    hasSaveAction(menu) && copyLinkLeaves(menu).some((copy) => !visibleCopyBeforeClick!.has(copy)));
}

function copyMenuDiagnostic(root: ParentNode): string {
  const allMenus = deepElements(root, "[role='menu']");
  const menus = allMenus
    .filter((menu) => visibleMenuElement(menu) && inViewport(menu));
  const opened = [...newlyOpenedOutsideMenus(root), ...newlyOpenedShadowMenus(root)];
  const updated = updatedVisibleMenus(root);
  const expanded = selectedDiscoveryMenuButton?.getAttribute("aria-expanded");
  const count = (value: number): number => Math.min(value, 99);
  const menuitems = menus.flatMap((menu) => deepElements(menu, "[role='menuitem']"))
    .filter((item) => visibleMenuElement(item) && inViewport(item));
  const pageMenuitems = deepElements(root, "[role='menuitem']")
    .filter((item) => visibleMenuElement(item) && inViewport(item));
  const outletElement = root.querySelector("#interop-outlet");
  const outlet = outletElement?.shadowRoot;
  const outletControls = outlet ? deepElements(outlet, "a, button, [role='menuitem'], [role='button']")
    .filter((item) => visibleMenuElement(item) && inViewport(item)) : [];
  return `expanded=${expanded === "true" || expanded === "false" ? expanded : "none"}` +
    `;totalMenus=${count(allMenus.length)};menus=${count(menus.length)};opened=${count(opened.length)};updated=${count(updated.length)}` +
    `;save=${count(menus.flatMap(saveActionLeaves).length)}` +
    `;copy=${count(menus.flatMap(copyLinkLeaves).length)};menuitems=${count(menuitems.length)}` +
    `;pageSave=${count(saveActionLeaves(root).length)};pageCopy=${count(copyLinkLeaves(root).length)}` +
    `;pageMenuitems=${count(pageMenuitems.length)};outlet=${outlet ? "open" : outletElement ? "closed" : "absent"}` +
    `;outletControls=${count(outletControls.length)}`;
}

/** Locate one Copy link control associated with the qualified card's opened menu. */
export function locateDiscoveryCopyLink(root: ParentNode): LocateResult & { diagnostic?: string } {
  const failed = (skipReason: string): LocateResult & { diagnostic: string } =>
    ({ ok: false, skipReason, diagnostic: copyMenuDiagnostic(root) });
  if (!(root instanceof Element) || !selectedDiscoveryMenuButton || !root.contains(selectedDiscoveryMenuButton))
    return failed("post-menu-not-selected");
  const opened = [...newlyOpenedOutsideMenus(root), ...newlyOpenedShadowMenus(root)];
  const menus = [...opened.filter(hasSaveAction), ...updatedVisibleMenus(root)];
  if (menus.length > 1) return failed("ambiguous-open-menu");
  const rolelessShadow = menus.length === 0 && !menuButtonWasExpanded
    ? root.querySelector("#interop-outlet")?.shadowRoot : null;
  const menu = menus[0] ?? rolelessShadow;
  if (!menu) return failed(opened.length ? "not-post-menu" : "post-menu-not-open");
  if (!hasSaveAction(menu)) return failed("not-post-menu");
  const copy = copyLinkLeaves(menu).filter((element) =>
    rolelessShadow ? !shadowCopyBeforeClick?.has(element) :
      visibleMenusBeforeClick?.has(menu as Element) ? !visibleCopyBeforeClick?.has(element) : true);
  if (copy.length !== 1) return failed(copy.length > 1 ? "ambiguous-copy-link" : "copy-link-not-found");
  const target = copy[0]!.closest("[role='menuitem']") ?? copy[0]!;
  const rect = elementRect(target);
  if (rect.width <= 0 || rect.height <= 0) return failed("copy-link-zero-rect");
  return { ok: true, ...elementCenter(target), rect, diagnostic: copyMenuDiagnostic(root) };
}

function openedPostMenus(root: ParentNode): ParentNode[] {
  const outlet = root.querySelector("#interop-outlet");
  const shadow = outlet?.shadowRoot;
  if (shadow && outlet && visibleMenuElement(outlet)) {
    const menus = Array.from(shadow.querySelectorAll("[role='menu']")).filter(visibleMenuElement);
    if (menus.length) return menus;
    // The current overlay has plain buttons, with neither menu nor menuitem
    // roles. Prefer its controls to unrelated visible page/navigation menus.
    const controls = shadow.querySelectorAll("a, button, [role='menuitem'], [role='button'], [data-url], [data-clipboard-text]");
    if (Array.from(controls).some(visibleMenuElement)) return [shadow];
  }
  const menus = root instanceof Element && root.matches("[role='menu']") ? [root] : [];
  return [...menus, ...root.querySelectorAll("[role='menu']")].filter(visibleMenuElement);
}

function menuDiagnostic(root: ParentNode): string {
  const outlet = root.querySelector("#interop-outlet");
  const shadow = outlet?.shadowRoot;
  const visible = visibleMenuElement;
  const menu = deepElements(shadow ?? root, "[role='menu']").find(visible);
  // The outlet is an isolated overlay. If LinkedIn changes the menu role, its
  // interactive children still give us a useful shape without scanning posts.
