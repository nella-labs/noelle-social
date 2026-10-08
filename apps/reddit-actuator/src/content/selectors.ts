// Reddit DOM selectors — the content script's READ-ONLY oracle.
//
// Supports BOTH new Reddit (www.reddit.com — `shreddit-*` web components, all in
// LIGHT DOM / slotted, reachable by document.querySelector; the DEFAULT actuation
// interface, matching the operator's own reads) and old Reddit (old.reddit.com —
// the decade-stable `.thing` markup, an opt-in path). Every read here is
// textContent / getAttribute / getBoundingClientRect
// ONLY — never innerHTML, never eval. Page text is DATA and never influences
// control flow. Selectors are pinned to stable hooks (`shreddit-*[attr]`,
// `data-*`, `[slot]`, `[name]`, text match) — NEVER Tailwind utility classes.
//
// Voting is UPVOTE-ONLY and operator opt-in. The operator explicitly overrode the
// prior no-vote default, so this file locates the UPVOTE affordance (findUpvoteButton
// / findFeedUpvoteTarget) — and NOTHING else vote-related. There is deliberately NO
// downvote selector anywhere: downvoting is never located and never performed. The
// background enforces a hard cap (≤10 upvotes / rolling 15 min, idle-only). Automated
// voting is a Reddit-ToS gray area (Disrupting Communities / Responsible Builder) the
// operator accepted; the upvote-only + hard-cap stance keeps it minimal. The write
// affordances located here are the reply composer + submit, and the upvote button.

export type RedditFlavor = "new" | "old";

/**
 * Which Reddit are we on? Hostname is the strongest signal (`old.reddit.com` is
 * unambiguous); otherwise sniff the DOM — a `shreddit-*` element ⇒ new, a
 * `.thing` ⇒ old. Defaults to "new" (www is the default host).
 */
export function detectFlavor(root: ParentNode, hostname?: string): RedditFlavor {
  if (hostname && hostname.toLowerCase().includes("old.reddit.com")) return "old";
  if (root.querySelector("shreddit-post, shreddit-comment, comment-composer-host")) return "new";
  if (root.querySelector(".thing.link, .thing.comment, .commentarea")) return "old";
  return "new";
}

/** Strip Reddit's fullname prefix (t1_/t3_/…) — returns null for empty input. */
function stripThing(id: string | null | undefined): string | null {
  if (!id) return null;
  const s = id.trim();
  return s ? s.replace(/^t\d+_/, "") : null;
}

function attrStr(el: Element, name: string): string | null {
  const v = el.getAttribute(name);
  return v && v.trim() ? v.trim() : null;
}

function attrInt(raw: string | null): number | null {
  if (raw == null) return null;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) ? n : null;
}

/** The subreddit name (no `r/`) parsed out of a permalink, or null. */
export function subredditFromPermalink(permalink: string | null): string | null {
  if (!permalink) return null;
  return /\/r\/([^/]+)/i.exec(permalink)?.[1] ?? null;
}

// ── Post ────────────────────────────────────────────────────────────────────

/** The primary post element on a comments page, or null. */
export function findPost(root: ParentNode, flavor: RedditFlavor): Element | null {
  return flavor === "old" ? root.querySelector(".thing.link") : root.querySelector("shreddit-post");
}

/** The post's t3 id, prefix stripped (new: `[id]`; old: `[data-fullname]`). */
export function postId(post: Element, flavor: RedditFlavor): string | null {
  return stripThing(flavor === "old" ? post.getAttribute("data-fullname") : post.getAttribute("id"));
}

/** The post author (no `u/`), or null. */
export function postAuthor(post: Element, flavor: RedditFlavor): string | null {
  return attrStr(post, flavor === "old" ? "data-author" : "author");
}

/** The post score as an int, or null (new: `[score]`; old: `[data-score]`). */
export function postScore(post: Element, flavor: RedditFlavor): number | null {
  return attrInt(post.getAttribute(flavor === "old" ? "data-score" : "score"));
}

/** The post's permalink path (new: `[permalink]`; old: `[data-permalink]`). */
export function postPermalink(post: Element, flavor: RedditFlavor): string | null {
  return attrStr(post, flavor === "old" ? "data-permalink" : "permalink");
}

/** The post's subreddit (no `r/`), derived from its permalink. */
export function postSubreddit(post: Element, flavor: RedditFlavor): string | null {
  return subredditFromPermalink(postPermalink(post, flavor));
}

/** The post title text. */
export function postTitle(post: Element, flavor: RedditFlavor): string {
  const el = flavor === "old" ? post.querySelector("a.title") : post.querySelector('[slot="title"]');
  return (el?.textContent ?? "").trim();
}

/** The post self-text body, trimmed (empty for link posts). */
export function postBody(post: Element, flavor: RedditFlavor): string {
  const el =
    flavor === "old"
      ? post.querySelector(".usertext-body .md")
      : post.querySelector('[slot="text-body"], div[property="schema:articleBody"], .md');
  return (el?.textContent ?? "").trim();
}

/** A best-effort full-res image URL for the post, or null. */
export function postImage(post: Element, flavor: RedditFlavor): string | null {
  if (flavor === "old") {
    const dataUrl = attrStr(post, "data-url");
    if (dataUrl && /^https?:\/\//i.test(dataUrl)) return dataUrl;
    const thumb = post.querySelector("a.thumbnail")?.getAttribute("href");
    return thumb && /^https?:\/\//i.test(thumb) ? thumb : null;
  }
  const href = attrStr(post, "content-href");
  if (href && /^https?:\/\//i.test(href)) return href;
  const img =
    post.querySelector('img#post-image') ??
    post.querySelector('[slot="post-media-container"] img.media-lightbox-img');
  const src = img?.getAttribute("src");
  return src && /^https?:\/\//i.test(src) ? src : null;
}

/** Word count of the post body — a dwell hint for the reading model. */
export function postWordCount(post: Element, flavor: RedditFlavor): number {
  return postBody(post, flavor).split(/\s+/).filter(Boolean).length;
}

/** True if the post carries an image/video/gallery. */
export function postHasMedia(post: Element, flavor: RedditFlavor): boolean {
  if (postImage(post, flavor) !== null) return true;
  if (flavor === "old") return post.querySelector("a.thumbnail, .expando video, .media-preview") !== null;
  const pt = (post.getAttribute("post-type") ?? "").toLowerCase();
  if (pt === "image" || pt === "video" || pt === "gallery") return true;
  return post.querySelector('img#post-image, video, [slot="post-media-container"]') !== null;
}

// ── Upvote (operator opt-in; UPVOTE-ONLY) ────────────────────────────────────

// The upvote-affordance selectors — the ONE definition of "what is an upvote
// button", shared by findUpvoteButton (the pressed-aware picker), the diagnostic
// counters, AND the findFeedPosts drift fallback so post-finding and upvoting can
// never disagree on what an upvote button IS (mirrors the LinkedIn actuator's
// shared LIKE_BUTTON_SELECTORS). Pressed-state filtering (old `.upmod`, new
// `aria-pressed`) is layered ON TOP by findUpvoteButton — never baked into these
// base selectors. UPVOTE-ONLY: there is deliberately no downvote selector here or
// anywhere in this file.
const NEW_UPVOTE_SEL = 'button[data-action-bar-action="upvote"]';
const OLD_UPVOTE_SEL = ".arrow.up";

/**
 * A post's UPVOTE button, or null if none is found OR the post is already upvoted.
 * UPVOTE-ONLY — there is deliberately no downvote counterpart in this file.
 *
 * New Reddit: the action bar lives inside shreddit-post's OPEN shadow root, so we
 * reach through `post.shadowRoot` for `button[data-action-bar-action="upvote"]`
 * (with a light-DOM fallback for resilience). `aria-pressed="true"` means the post
 * is already upvoted → return null (skip; never toggle a vote back off).
 * getBoundingClientRect works across an open shadow boundary, so the caller still
 * derives a click rect from the returned button.
 *
 * Old Reddit: `.thing.link .arrow.up`. Once upvoted it gains `.upmod`, so an
 * `.arrow.up.upmod` is already-upvoted (the `:not(.upmod)` filter returns null →
 * skip). The `.arrow.down` is never selected — no downvote, ever.
 */
export function findUpvoteButton(post: Element, flavor: RedditFlavor): HTMLElement | null {
  if (flavor === "old") {
    // The un-modded up arrow only; an already-upvoted `.arrow.up.upmod` won't match.
    return post.querySelector<HTMLElement>(`${OLD_UPVOTE_SEL}:not(.upmod)`) ?? null;
  }
  const shadow = (post as HTMLElement).shadowRoot;
  const btn =
    shadow?.querySelector<HTMLElement>(NEW_UPVOTE_SEL) ??
    post.querySelector<HTMLElement>(NEW_UPVOTE_SEL);
  if (!btn) return null;
  if ((btn.getAttribute("aria-pressed") ?? "").toLowerCase() === "true") return null; // already upvoted → skip
  return btn;
}

/**
 * Every upvote AFFORDANCE under root, pressed or not — light DOM plus every
 * shreddit-post OPEN shadow root — REUSING the same base selectors as
 * findUpvoteButton / countUpvoteButtons so the upvote path and the findFeedPosts
 * drift fallback share ONE button definition (mirrors linkedin's findLikeButtons
 * over the shared LIKE_BUTTON_SELECTORS). Order-preserving. UPVOTE-ONLY.
 */
function findUpvoteButtonsAnywhere(root: ParentNode, flavor: RedditFlavor): HTMLElement[] {
  if (flavor === "old") return Array.from(root.querySelectorAll<HTMLElement>(OLD_UPVOTE_SEL));
  const out: HTMLElement[] = Array.from(root.querySelectorAll<HTMLElement>(NEW_UPVOTE_SEL));
  for (const p of Array.from(root.querySelectorAll("shreddit-post"))) {
    const shadow = (p as HTMLElement).shadowRoot;
    if (shadow) out.push(...Array.from(shadow.querySelectorAll<HTMLElement>(NEW_UPVOTE_SEL)));
  }
  return out;
}

/**
 * The post-sized container that wraps a single upvote button: the LARGEST
 * ancestor that still contains exactly this one upvote affordance (its parent
 * would also wrap the NEXT post's). Lands on the feed list-item / card even when
 * its tag and attributes have drifted, so postId / postSubreddit (queried within
 * the returned container) still resolve. When the button lives inside a
 * shreddit-post's OPEN shadow root the climb crosses the boundary via
 * getRootNode().host — parentElement is null at the top of a shadow tree.
 * Mirrors linkedin's postContainerOf; UPVOTE-ONLY.
 */
function postContainerOf(btn: Element, root: ParentNode, flavor: RedditFlavor): Element | null {
  const rootEl = root instanceof Element ? root : null;
  const parentOf = (n: Element): Element | null => {
    if (n.parentElement) return n.parentElement;
    const r = n.getRootNode();
    return r instanceof ShadowRoot ? r.host : null;
  };
  let node = parentOf(btn);
  let best: Element | null = null;
  while (node && node !== rootEl) {
    if (findUpvoteButtonsAnywhere(node, flavor).length === 1) best = node;
    else break; // parent now wraps a second post → stop at the previous ancestor
    node = parentOf(node);
  }
  return best;
}

/**
 * Every feed post container in the document (home / r/all / r/popular / a
 * subreddit listing). The single source for "what counts as a feed post" so the
 * upvote target scan and the skip-reason diagnostics can never disagree.
 *
 * Drift-resistant fallback (ports linkedin/x findFeedPosts): when EVERY container
 * selector misses (a renamed tag/attrs — the exact `posts=0` failure that
 * countUpvoteButtons only DETECTS), derive posts from their upvote buttons
 * instead, reusing the one shared upvote-affordance definition. The upvote button
 * keeps its stable hook across redesigns, so each button ⇒ climb to the
 * post-sized container that wraps exactly it. UPVOTE-ONLY — the fallback never
 * widens to a downvote. Deduped so a button shared with a nested container can't
 * double-count.
 */
export function findFeedPosts(root: ParentNode, flavor: RedditFlavor): Element[] {
  const out = new Set<Element>();
  const primary = flavor === "old" ? ".thing.link" : "shreddit-post";
  for (const el of Array.from(root.querySelectorAll(primary))) out.add(el);
  if (out.size === 0) {
    for (const btn of findUpvoteButtonsAnywhere(root, flavor)) {
      const post = postContainerOf(btn, root, flavor);
      if (post) out.add(post);
    }
  }
  return Array.from(out);
}

/**
 * Does this post carry an upvote button at all — pressed or not? Diagnostic-only
 * companion to findUpvoteButton (which returns null for an already-upvoted post):
 * the two together separate "all already upvoted" from "no button rendered".
 */
export function postHasUpvoteButton(post: Element, flavor: RedditFlavor): boolean {
  if (flavor === "old") return post.querySelector(OLD_UPVOTE_SEL) !== null;
  const shadow = (post as HTMLElement).shadowRoot;
  return (shadow?.querySelector(NEW_UPVOTE_SEL) ?? post.querySelector(NEW_UPVOTE_SEL)) !== null;
}

/**
 * Count upvote buttons ANYWHERE on the page — light DOM plus every shreddit-post
 * open shadow root — regardless of pressed state or owning container. A pure
 * diagnostic for the enriched no-upvotable-post skip reason: btns>0 with posts=0
 * means the container selectors drifted while the affordance survived.
 */
export function countUpvoteButtons(root: ParentNode, flavor: RedditFlavor): number {
  // Same button definition as findFeedPosts' drift fallback (findUpvoteButtonsAnywhere)
  // so a `btns>0, posts=0` skip reason can never be an artefact of two selectors.
  return findUpvoteButtonsAnywhere(root, flavor).length;
}

/**
 * On a feed (home / r/all / r/popular / a subreddit) a post whose upvote button
 * is not already pressed, plus that owning post (for the observed post
 * id/subreddit). With an `rng` the pick is a RANDOM IN-VIEW candidate — always
 * taking the topmost not-yet-upvoted post is a positional fingerprint (ports
 * LinkedIn #429's locateLikeTarget randomization); without one (older
 * callers/tests) it stays the first match. Returns null when every post is
 * already upvoted, or none is found. UPVOTE-ONLY.
 *
 * IN-VIEW FILTER (ports locateLikeTarget's viewport restriction): after a
 * session of ambient scrolling the feed DOM holds pages of posts, and a uniform
 * pick over ALL of them regularly lands far off-screen — the caller's
 * scrollIntoView then executes an instantaneous multi-page teleport with zero
 * wheel gestures, itself a bot fingerprint (the exact class #429 removes) that
 * also yanks the viewport away from where the simulated reader was. So the pick
 * is restricted to posts whose top edge is in/just-below the current viewport
 * (top in (-200, 1.4×viewportHeight)), falling back to every candidate only
 * when none is in view. Post containers come from findFeedPosts (single source).
 */
export function findFeedUpvoteTarget(
  root: ParentNode,
  flavor: RedditFlavor,
  rng?: { int(min: number, max: number): number },
): { el: HTMLElement; post: Element } | null {
  const candidates: Array<{ el: HTMLElement; post: Element }> = [];
  for (const p of findFeedPosts(root, flavor)) {
    const btn = findUpvoteButton(p, flavor);
    if (btn) candidates.push({ el: btn, post: p });
  }
  if (candidates.length === 0) return null;
  const vh = typeof window !== "undefined" ? window.innerHeight || 800 : 800;
  const inView = candidates.filter(({ post }) => {
    const top = post.getBoundingClientRect().top;
    return top > -200 && top < vh * 1.4;
  });
  const pool = inView.length > 0 ? inView : candidates;
  return pool[rng ? rng.int(0, pool.length - 1) : 0]!;
}

// ── Save (operator opt-in; SAVE-ONLY, never a vote) ──────────────────────────

// A post-SAVE is a private bookmark — NOT a vote — so it does not touch the
// Reddit vote-manipulation ToS clause the upvote path skirts (a downvote would).
// Mirrors the X actuator's default-OFF bookmark. SAVE-ONLY: there is deliberately
// no downvote/vote counterpart located here or anywhere in this file.
//
// New Reddit: Save is NOT in the post's action bar — it lives inside the post's
// overflow "…" (more) menu. So findSaveButton returns the overflow MENU OPENER
// (the affordance to click to reveal the Save item), reusing the SAME shadow-DOM
// reach as findUpvoteButton (through `post.shadowRoot`, with a light-DOM
// fallback). The Save item itself is located separately by findSaveMenuItem once
// the menu is open. An already-saved post is skipped via the shreddit-post
// `saved` boolean attribute — never re-save.
//
// Old Reddit: Save is a direct `.save-button` / form link on the `.thing.link`;
// once saved the link text flips to "unsave" and the thing gains `.saved`, so
// both are skipped. LIVE-TUNE: the exact new-Reddit overflow hook may drift — a
// miss just returns null and the caller falls back to a plain upvote (the
// engagement is never lost), so best-effort selectors are safe here by design.
const NEW_SAVE_MENU_SEL =
  'button[data-action-bar-action="overflow"], shreddit-post-overflow-menu button, button[aria-label*="more option" i], shreddit-post-overflow-menu';
const OLD_SAVE_SEL = ".save-button a, .link-save-button a, form.save-button a";

/** True when a new-Reddit shreddit-post carries a truthy `saved` boolean
 * attribute (already saved). Mirrors newPostFlagAttr's boolean-attr semantics:
 * present with any value other than "false" ⇒ saved. */
function newPostSaved(post: Element): boolean {
  const v = post.getAttribute("saved");
  return v !== null && v.trim().toLowerCase() !== "false";
}

/**
 * A post's SAVE affordance, or null if none is found OR the post is already saved.
 * SAVE-ONLY — there is deliberately no downvote/vote counterpart in this file.
 *
 * New Reddit: returns the overflow "…" MENU OPENER inside shreddit-post's OPEN
 * shadow root (light-DOM fallback for resilience) — clicking it reveals the Save
 * item (located by findSaveMenuItem). A truthy `saved` attribute ⇒ already saved
 * → return null (skip; never re-save). getBoundingClientRect works across an open
 * shadow boundary, so the caller still derives a click rect from the returned
 * element.
 *
 * Old Reddit: the `.save-button` link whose text is "save" (never "unsave" — that
 * is the already-saved state), and only when the `.thing.link` lacks `.saved`.
 */
export function findSaveButton(post: Element, flavor: RedditFlavor): HTMLElement | null {
  if (flavor === "old") {
    if ((post as HTMLElement).classList?.contains("saved")) return null; // already saved → skip
    for (const a of Array.from(post.querySelectorAll<HTMLElement>(OLD_SAVE_SEL))) {
      if ((a.textContent ?? "").trim().toLowerCase() === "save") return a; // skips "unsave"
    }
    return null;
  }
  if (newPostSaved(post)) return null; // already saved → skip
  const shadow = (post as HTMLElement).shadowRoot;
  return (
    shadow?.querySelector<HTMLElement>(NEW_SAVE_MENU_SEL) ??
    post.querySelector<HTMLElement>(NEW_SAVE_MENU_SEL) ??
    null
  );
}

/**
 * The "Save" item inside the open overflow menu (New Reddit two-step only). The
 * menu portals out of the post (a faceplate/shreddit menu), so search from the
 * root. Match a menu item whose EXACT trimmed text/aria is "Save" — never "Saved"
 * or "Unsave" (the already-saved states we must never click). Mirrors x-actuator
 * findRetweetConfirm: the caller must NOT scrollIntoView it — a scroll dismisses
 * the menu. Returns null when the menu isn't open / the item drifted, so the
 * caller Escape-dismisses and falls back to a plain upvote.
 */
export function findSaveMenuItem(root: ParentNode): HTMLElement | null {
  const byHook = root.querySelector<HTMLElement>(
    'button[data-action-bar-action="save"], [role="menuitem"][aria-label="Save" i]',
  );
  if (byHook) return byHook;
  const menu = root.querySelector<HTMLElement>('[role="menu"], shreddit-post-overflow-menu, faceplate-menu');
  const scope: ParentNode = menu ?? root;
  for (const item of Array.from(scope.querySelectorAll<HTMLElement>('[role="menuitem"], button, li, a'))) {
    const label = ((item.getAttribute("aria-label") || item.textContent) ?? "").trim();
    if (/^save$/i.test(label)) return item; // exact word — never "Saved"/"Unsave"
  }
  return null;
}

/**
 * On a feed, a post whose SAVE affordance is available (not already saved), plus
 * that owning post (for the observed post id/subreddit). Mirrors
