// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  findLikeButton, isAlreadyLiked, isSponsored, findCommentBox, findFeedPosts, postActivityUrn,
  findSeeMore, postText, wordCount, hasMedia, isTruncated, findCommentsToggle, hasComments,
  findChallenge, findCommentSubmit, diagnoseCommentSubmit, isPostUnavailable, isCommentRestricted, commentBoxText,
  findReactionsMenu, findReactionButton,
} from "../../src/content/selectors.js";

const here = dirname(fileURLToPath(import.meta.url));
const fx = (name: string) => readFileSync(join(here, "..", "fixtures", name), "utf8");

function mount(html: string): HTMLElement {
  document.body.innerHTML = html;
  return document.body;
}

describe("selectors", () => {
  it("finds a feed post and its activity urn", () => {
    const root = mount(fx("feed-post.html"));
    const posts = findFeedPosts(root);
    expect(posts).toHaveLength(1);
    expect(postActivityUrn(posts[0]!)).toBe("urn:li:activity:7300000000000000000");
  });

  it("finds the like button and reads unliked state", () => {
    const root = mount(fx("feed-post.html"));
    const post = findFeedPosts(root)[0]!;
    expect(findLikeButton(post)).not.toBeNull();
    expect(isAlreadyLiked(post)).toBe(false);
  });

  it("detects sponsored posts", () => {
    const root = mount(fx("sponsored-post.html"));
    expect(isSponsored(findFeedPosts(root)[0]!)).toBe(true);
  });

  it("finds the comment textbox", () => {
    const root = mount(fx("comment-box.html"));
    expect(findCommentBox(root)).not.toBeNull();
  });

  it("finds the enabled editor inside the current commentBox anchor", () => {
    const root = mount(
      '<div componentkey="commentBox-current">' +
        '<div role="textbox" contenteditable="false" aria-label="Disabled editor"></div>' +
        '<div role="textbox" aria-label="Text editor for creating comment"></div>' +
        "</div>",
    );
    expect(findCommentBox(root)?.getAttribute("aria-label")).toBe("Text editor for creating comment");
  });

  it("never accepts contenteditable=false inside a current commentBox anchor", () => {
    const root = mount(
      '<div componentkey="commentBox-current">' +
        '<div role="textbox" contenteditable="false" aria-label="Text editor for creating comment"></div>' +
        "</div>",
    );
    expect(findCommentBox(root)).toBeNull();
  });

  it("returns null/empty when selectors are absent (no throw)", () => {
    const root = mount("<div>nothing here</div>");
    expect(findFeedPosts(root)).toHaveLength(0);
    expect(findCommentBox(root)).toBeNull();
  });
});

describe("findFeedPosts drift-resistant fallback (container classes renamed)", () => {
  it("recovers both posts from their Like buttons when no container selector matches", () => {
    const root = mount(fx("feed-drifted.html"));
    const posts = findFeedPosts(root);
    // Neither post carries a known container class/attr, yet both are found.
    expect(posts).toHaveLength(2);
    // Each returned container is a distinct post-sized box (not the shared feed
    // container collapsed to one), with its own single Like button + actor.
    for (const p of posts) {
      expect(findLikeButton(p)).not.toBeNull();
      expect(p.querySelector(".update-components-actor__name")).not.toBeNull();
    }
  });

  it("the climbed container preserves sponsored detection", () => {
    const root = mount(fx("feed-drifted.html"));
    const posts = findFeedPosts(root);
    const sponsored = posts.filter((p) => isSponsored(p));
    // Exactly the Acme "Promoted" post is sponsored; Alice's is not.
    expect(sponsored).toHaveLength(1);
    expect(sponsored[0]!.textContent).toContain("Acme Corp");
  });

  it("does NOT run the fallback when a container selector matches (unchanged behavior)", () => {
    // feed-post.html matches feed-shared-update-v2 → exactly one post, and the
    // fallback (which could over/under-count) never fires.
    const root = mount(fx("feed-post.html"));
    expect(findFeedPosts(root)).toHaveLength(1);
  });
});

describe("2026 feed markup — reaction-state like button + renamed containers", () => {
  // Real drift observed on the live feed (2026-07): the react/like toggle is
  // labelled "Reaction button state: no reaction" / "…: like" (no aria-pressed),
  // and the feed-shared-update-v2 / data-urn container markup is gone. This was
  // the live posts=0,withBtn=0,btns=0 cause. Two posts so the container fallback
  // climb stops at each post card, not the shared feed wrapper.
  const twoPosts =
    "<div class='scaffold-finite-scroll__content'>" +
      "<div class='reef-card'>" +
        "<span class='update-components-actor__name'>Alice</span>" +
        "<div class='social-actions'>" +
          "<button aria-label='Reaction button state: no reaction' type='button'>Like</button>" +
          "<button aria-label='Open reactions menu' type='button'>React</button>" +
          "<button aria-label='Comment' type='button'>Comment</button>" +
        "</div>" +
      "</div>" +
      "<div class='reef-card'>" +
        "<span class='update-components-actor__name'>Bob</span>" +
        "<div class='social-actions'>" +
          "<button aria-label='Reaction button state: like' type='button'>Like</button>" +
          "<button aria-label='Comment' type='button'>Comment</button>" +
        "</div>" +
      "</div>" +
    "</div>";

  it("finds both posts via the reaction-state button when container classes/urns are gone", () => {
    const posts = findFeedPosts(mount(twoPosts));
    expect(posts).toHaveLength(2);
    for (const p of posts) expect(findLikeButton(p)).not.toBeNull();
  });

  it("targets the reaction toggle, not the 'Open reactions menu' affordance", () => {
    const post = findFeedPosts(mount(twoPosts))[0]!;
    expect(findLikeButton(post)!.getAttribute("aria-label")).toMatch(/reaction button state/i);
  });

  it("reads liked state from the label (no aria-pressed): 'no reaction' vs reacted", () => {
    const posts = findFeedPosts(mount(twoPosts));
    const alice = posts.find((p) => p.textContent?.includes("Alice"))!;
    const bob = posts.find((p) => p.textContent?.includes("Bob"))!;
    expect(isAlreadyLiked(alice)).toBe(false); // "no reaction" → likeable
    expect(isAlreadyLiked(bob)).toBe(true); // "like" → already reacted
  });
});

describe("live 2026 feed capture (real obfuscated markup)", () => {
  // The actual DOM a live session pasted: obfuscated classes, role=listitem
  // containers with componentkey='…FeedType_MAIN_FEED_RELEVANCE', no data-urn.
  // Proves the like path works on the current feed — so a `btns=0` skip means the
  // scan ran off-feed (e.g. tab parked on a dead post), NOT a dead selector.
  it("recovers both real posts and their reaction-state like buttons", () => {
    const posts = findFeedPosts(mount(fx("feed-2026-obfuscated.html")));
    expect(posts).toHaveLength(2);
    for (const p of posts) {
      expect(findLikeButton(p)!.getAttribute("aria-label")).toMatch(/reaction button state/i);
    }
  });

  it("does not mistake the comment-section reaction (a div/svg, not a button) for a like", () => {
    // Post 1's comment thread has a <div role=button><svg role=img
    // aria-label='Reaction button state…'> — same label, but not a <button>. If it
    // were counted, postContainerOf would see 2 like buttons in one post and
    // collapse the container. Exactly one <button> like control per post keeps the
    // post-sized container intact.
    const root = mount(fx("feed-2026-obfuscated.html"));
    const ron = findFeedPosts(root).find((p) => p.textContent?.includes("Ron Wiener"))!;
    const likeButtons = Array.from(ron.querySelectorAll("button[aria-label^='Reaction button state' i]"));
    expect(likeButtons).toHaveLength(1);
    expect(isAlreadyLiked(ron)).toBe(false); // action-bar toggle reads "no reaction"
  });
});

describe("content-detection selectors", () => {
  it("findSeeMore returns the toggle button on a long post", () => {
    const root = mount(fx("long-post.html"));
    const post = findFeedPosts(root)[0]!;
    const btn = findSeeMore(post);
    expect(btn).not.toBeNull();
    expect(btn!.tagName.toLowerCase()).toBe("button");
  });

  it("findSeeMore returns null on a plain feed post with no toggle", () => {
    const root = mount(fx("feed-post.html"));
    const post = findFeedPosts(root)[0]!;
    expect(findSeeMore(post)).toBeNull();
  });

  it("wordCount is > 50 on a long post", () => {
    const root = mount(fx("long-post.html"));
    const post = findFeedPosts(root)[0]!;
    expect(wordCount(post)).toBeGreaterThan(50);
  });

  it("wordCount is small on a plain feed post (no body text)", () => {
    const root = mount(fx("feed-post.html"));
    const post = findFeedPosts(root)[0]!;
    expect(wordCount(post)).toBeLessThan(10);
  });

  it("hasMedia is true on a post containing an image", () => {
    const root = mount(fx("media-post.html"));
    const post = findFeedPosts(root)[0]!;
    expect(hasMedia(post)).toBe(true);
  });

  it("hasMedia is false on a plain feed post with no image or video", () => {
    const root = mount(fx("feed-post.html"));
    const post = findFeedPosts(root)[0]!;
    expect(hasMedia(post)).toBe(false);
  });

  it("isTruncated is true on a long post with a see-more toggle", () => {
    const root = mount(fx("long-post.html"));
    const post = findFeedPosts(root)[0]!;
    expect(isTruncated(post)).toBe(true);
  });

  it("isTruncated is false on a plain feed post", () => {
    const root = mount(fx("feed-post.html"));
    const post = findFeedPosts(root)[0]!;
    expect(isTruncated(post)).toBe(false);
  });
});

describe("comments-open selector", () => {
  it("prefers the social-counts 'N comments' button on a post with a discussion", () => {
    const root = mount(fx("commented-post.html"));
    const post = findFeedPosts(root)[0]!;
    const btn = findCommentsToggle(post);
    expect(btn).not.toBeNull();
    expect(btn!.getAttribute("aria-label")).toMatch(/\d+\s+comments/i);
    expect(hasComments(post)).toBe(true);
  });

  it("falls back to the action-bar Comment button when there is no count row", () => {
    const root = mount(fx("feed-post.html"));
    const post = findFeedPosts(root)[0]!;
    const btn = findCommentsToggle(post);
    expect(btn).not.toBeNull();
    expect(btn!.getAttribute("aria-label")).toMatch(/^Comment/i);
    expect(hasComments(post)).toBe(true);
  });

  it("never treats the composer 'Post comment' submit as a read affordance", () => {
    const root = mount(
      "<div class='feed-shared-update-v2' data-urn='urn:li:activity:1'>" +
        "<button aria-label='Post comment' type='button'>Post</button>" +
        "</div>",
    );
    const post = findFeedPosts(root)[0]!;
    // starts-with 'Comment' (not contains) keeps 'Post comment' out.
    expect(findCommentsToggle(post)).toBeNull();
  });

  it("returns null / false when no comments affordance exists", () => {
    const root = mount("<div class='feed-shared-update-v2'>no actions</div>");
    const post = findFeedPosts(root)[0] ?? root.firstElementChild!;
    expect(findCommentsToggle(post)).toBeNull();
    expect(hasComments(post)).toBe(false);
  });
});

describe("isPostUnavailable (deleted/unavailable post permalink)", () => {
  it("is TRUE on the 'This post cannot be displayed' page", () => {
    expect(isPostUnavailable(mount(fx("post-unavailable.html")))).toBe(true);
  });

  it("is TRUE on the 'no longer available' variant", () => {
    expect(isPostUnavailable(mount("<main><h2>This post is no longer available</h2></main>"))).toBe(true);
  });

  it("is FALSE on a normal feed post (no false positive)", () => {
    expect(isPostUnavailable(mount(fx("feed-post.html")))).toBe(false);
  });

  it("is FALSE on a post that merely talks about displaying posts", () => {
    expect(
      isPostUnavailable(mount("<div class='feed-shared-update-v2'>Here's how to display a post on your profile.</div>")),
    ).toBe(false);
  });
});

describe("isCommentRestricted (comments limited to connections)", () => {
  it("is TRUE on the 'Only connections can comment on this post' banner", () => {
    expect(isCommentRestricted(mount(fx("comment-restricted.html")))).toBe(true);
  });

  it("is TRUE on the 'only people <name> follows can comment' variant", () => {
    expect(
      isCommentRestricted(mount("<main><p>Only people Jane Doe follows can comment on this post.</p></main>")),
    ).toBe(true);
  });

  it("is TRUE on a 'commenting has been turned off' variant", () => {
    expect(
      isCommentRestricted(mount("<main><p>Commenting has been turned off for this post.</p></main>")),
    ).toBe(true);
  });

  it("is FALSE on a normal feed post with an open composer (no false positive)", () => {
    expect(isCommentRestricted(mount(fx("feed-post.html")))).toBe(false);
    expect(isCommentRestricted(mount(fx("comment-box.html")))).toBe(false);
  });

  it("is FALSE on a post that merely uses the word 'comment'", () => {
    expect(
      isCommentRestricted(mount("<main><p>Drop a comment on this post if you agree!</p></main>")),
    ).toBe(false);
  });
});

describe("findChallenge (tight — no false positives on normal content)", () => {
  it("is FALSE on ordinary content that mentions verify/security/unusual activity", () => {
    // Regression: the old text/class substring scan halted valid runs on posts
    // and comments that merely used these words.
    expect(
      findChallenge(mount("<article>Please verify your identity — a security check about unusual activity in job apps</article>")),
    ).toBe(false);
  });

  it("is FALSE on a normal feed post", () => {
    expect(findChallenge(mount("<div class='feed-shared-update-v2'>a normal post</div>"))).toBe(false);
  });

  it("is TRUE on a real captcha vendor iframe (arkose)", () => {
    expect(findChallenge(mount("<iframe src='https://x.arkoselabs.com/fc'></iframe>"))).toBe(true);
  });

  it("is FALSE on an ad iframe that merely contains 'captcha' in the src", () => {
    // The old generic iframe[src*='captcha'] scan risked false positives; the
    // tightened check only trusts the actual challenge vendors.
    expect(findChallenge(mount("<iframe src='https://ads.example.com/nocaptcha-banner'></iframe>"))).toBe(false);
  });

  it("is TRUE on a /checkpoint/ URL", () => {
    history.pushState({}, "", "/checkpoint/challenge/verify");
    try {
      expect(findChallenge(mount("<div>anything</div>"))).toBe(true);
    } finally {
      history.pushState({}, "", "/");
    }
  });
});

describe("findCommentSubmit", () => {
  it("finds the BEM submit button (with a state suffix)", () => {
    expect(
      findCommentSubmit(mount("<button class='comments-comment-box__submit-button--cr'>Comment</button>")),
    ).not.toBeNull();
  });

  it("finds the composer's primary button, not the action-bar Comment toggle", () => {
    const btn = findCommentSubmit(
      mount(
        "<div class='feed-shared-social-action-bar'><button aria-label=\"Comment on Jane's post\">Comment</button></div>" +
          "<div class='comments-comment-box'><button class='artdeco-button artdeco-button--primary'>Comment</button></div>",
      ),
    );
    expect(btn).not.toBeNull();
    expect(btn!.className).toContain("artdeco-button--primary");
  });

  it("returns null when there is no composer", () => {
    expect(findCommentSubmit(mount("<div>nothing</div>"))).toBeNull();
  });

  it("finds the #420-era bare 'Comment' button (no primary class) inside the legacy composer", () => {
    // An era of the legacy UI where the live submit was a plain enabled button
    // with text exactly 'Comment' — NOT primary-styled — next to the box.
    const btn = findCommentSubmit(
      mount(
        "<div class='feed-shared-social-action-bar'><button type='button' aria-label=\"Comment on Jane Doe's post\">Comment</button></div>" +
          "<div class='comments-comment-box'>" +
          "<div role='textbox' contenteditable='true'></div>" +
          "<button type='button' class='qjkzvz'>Comment</button>" +
          "</div>",
      ),
    );
    expect(btn).not.toBeNull();
    expect(btn!.className).toBe("qjkzvz");
  });

  it("returns null for a DISABLED BEM submit (the poll must wait, not click a no-op)", () => {
    // The old pass-0 returned the BEM button unconditionally; clicking a
    // disabled submit silently no-ops and burns the attempt.
    expect(
      findCommentSubmit(
        mount(
          "<div class='comments-comment-box'>" +
            "<div role='textbox' contenteditable='true'>draft text</div>" +
            "<button class='comments-comment-box__submit-button' disabled type='button' aria-label='Post comment'>Post</button>" +
            "</div>",
        ),
      ),
    ).toBeNull();
  });

  it("never returns a thread Reply button when the real submit is absent", () => {
