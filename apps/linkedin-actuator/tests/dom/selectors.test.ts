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
