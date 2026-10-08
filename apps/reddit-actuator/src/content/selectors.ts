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
