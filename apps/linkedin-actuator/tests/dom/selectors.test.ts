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
    // Legacy comment thread below the main composer: the ONLY wordy buttons are
    // per-comment Reply affordances inside comments-comment-item articles. The
    // old bare document-order word scan grabbed the first one.
    expect(
      findCommentSubmit(
        mount(
          "<div class='comments-comment-box'>" +
            "<div role='textbox' contenteditable='true'>draft text</div>" +
            "</div>" +
            "<article class='comments-comment-item'><p>Nice!</p><button type='button' aria-label='Reply'>Reply</button></article>" +
            "<article class='comments-comment-item'><p>Agreed.</p><button type='button' aria-label='Reply'>Reply</button></article>",
        ),
      ),
    ).toBeNull();
  });
});

describe("findCommentSubmit — 2026 migrated UI (obfuscated classes, bare-'Comment' toggle)", () => {
  // THE live bug (comment-failed:not-cleared wall): on the 2026 feed the
  // action-bar toggle is labelled bare "Comment" (the possessive exclusion went
  // dead) and precedes the composer, so the old document-order word scan
  // returned the TOGGLE — the background clicked it once, nothing ever posted.
  it("does NOT return the action-bar 'Comment' toggle on the real 2026 feed capture", () => {
    const root = mount(fx("feed-2026-obfuscated.html"));
    // The decoy IS present in the capture — the test is meaningful.
    expect(root.querySelector("button[aria-label='Comment']")).not.toBeNull();
    const hit = findCommentSubmit(root);
    // Specifically: not the bare-'Comment' action-bar toggle…
    expect(hit?.getAttribute("aria-label") ?? null).not.toBe("Comment");
    // …and with no composer open on the feed there is nothing to submit at all.
    expect(hit).toBeNull();
  });

  it("returns THE composer submit (in commentButtonSection) — not the toggle, not Reply", () => {
    // The live 2026 submit is a type=button labelled by the WORD "Comment" as
    // text, inside a commentButtonSection wrapper, with NO comment-small sprite.
    const btn = findCommentSubmit(mount(fx("comment-box-2026.html")));
    expect(btn).not.toBeNull();
    expect(btn!.closest("[componentkey*='commentButtonSection']")).not.toBeNull(); // the real submit's wrapper
    expect(btn!.textContent?.trim()).toBe("Comment");
    expect(btn!.getAttribute("aria-label")).toBeNull(); // the toggle carries aria-label='Comment'
    expect(btn!.querySelector("svg[id='comment-small']")).toBeNull(); // the toggle carries the sprite; the submit doesn't
  });

  it("returns null while the submit is disabled (toggle + Reply decoys present)", () => {
    // The submit is disabled until typing registers. A null keeps the
    // background's poll waiting for it to enable, instead of clicking a decoy.
    const root = mount(fx("comment-box-2026.html"));
    root.querySelector<HTMLButtonElement>("button[componentkey*='commentButtonSection']")!.disabled = true;
    expect(findCommentSubmit(root)).toBeNull();
  });

  it("also finds a type='submit' variant of the composer submit", () => {
    // Some migrated surfaces carry type=submit on the composer button — the
    // anchored search must find it either way.
    const root = mount(fx("comment-box-2026.html"));
    root.querySelector<HTMLButtonElement>("button[componentkey*='commentButtonSection']")!.setAttribute("type", "submit");
    const btn = findCommentSubmit(root);
    expect(btn).not.toBeNull();
    expect(btn!.closest("[componentkey*='commentButtonSection']")).not.toBeNull();
  });

  // ── Wrong-surface safety ──────────────────────────────────────────────────
  // The messaging overlay (chat bubbles) persists across navigations and its
  // Send button is type=submit: anything the comment flow "submits" there is a
  // PRIVATE MESSAGE that clears the pane and reads as posted. These lock the
  // two guards that make it unreachable: the box-anchor rejection and the
  // mandatory word-gate (styling alone never qualifies a button).

  it("never returns the chat overlay's Send when the composer is missing", () => {
    const root = mount(
      "<main><p>post body — composer not hydrated yet</p></main>" +
        "<aside class='msg-overlay-list-bubble'><form class='msg-form'>" +
        "<div role='textbox' contenteditable='true' aria-label='Write a message…'>typed here</div>" +
        "<button type='submit' class='msg-form__send-button artdeco-button artdeco-button--primary'>Send</button>" +
        "</form></aside>",
    );
    expect(findCommentSubmit(root)).toBeNull();
  });

  it("a bare type=submit 'Send' is rejected even outside a msg container (NONCOMMENT guard)", () => {
    // The icon-only-submit relaxation accepts a following type=submit — but NOT
    // when its name is a different action. 'Send' would post a DM; even with
    // messaging classes obfuscated away from MESSAGING_SEL, the name guard keeps
    // it out.
    const root = mount(
      "<div class='_0k3j'><div role='textbox' contenteditable='true'>typed comment</div>" +
        "<button type='submit' class='_h4x8' aria-label='Send'>Send</button></div>",
    );
    expect(findCommentSubmit(root)).toBeNull();
  });

  it("an ICON-ONLY comment submit (type=submit, no submit word) IS found via the anchor", () => {
    // The live wf=0 shape: composer editor followed by an unworded type=submit
    // (icon-only, or aria like 'Add a comment'). Neither is in the exact word
    // list, so the old word-only anchor missed it → submit-not-found wall.
    const iconOnly = mount(
      "<div class='_c9'><div role='textbox' contenteditable='true'>great point</div>" +
        "<button type='button' class='_e' aria-label='Emoji'></button>" +
        "<button type='submit' class='_sub'><svg viewBox='0 0 24 24'></svg></button></div>",
    );
    expect(findCommentSubmit(iconOnly)?.className).toBe("_sub");
    const ariaLabelled = mount(
      "<div class='_c9'><div role='textbox' contenteditable='true'>great point</div>" +
        "<button type='submit' class='_sub2' aria-label='Add a comment'></button></div>",
    );
    expect(findCommentSubmit(ariaLabelled)?.className).toBe("_sub2");
  });

  it("worded submit still wins the tiebreak over an unworded type=submit (legacy unchanged)", () => {
    // A worded 'Post' and an icon-only submit both follow the box → the worded
    // one scores higher, so nothing about legacy/worded surfaces changes.
    const root = mount(
      "<div class='_c'><div role='textbox' contenteditable='true'>x</div>" +
        "<button type='submit' class='_icon'></button>" +
        "<button type='button' class='artdeco-button--primary _post'>Post</button></div>",
    );
    const hit = findCommentSubmit(root);
    expect(hit?.textContent).toBe("Post");
    expect(hit?.className).toContain("_post");
  });

  it("waits (null) on a disabled submit instead of escaping the climb to the chat overlay", () => {
    // The enable-lag window: the real submit exists but hasn't enabled yet.
    // The climb must stop at it — widening past it is what would reach decoys.
    const root = mount(fx("comment-box-2026.html"));
    root.querySelector<HTMLButtonElement>("button[componentkey*='commentButtonSection']")!.disabled = true;
    root.insertAdjacentHTML(
      "beforeend",
      "<aside class='msg-overlay-list-bubble'><form class='msg-form'>" +
        "<div role='textbox' contenteditable='true'></div>" +
        "<button type='submit' class='msg-form__send-button artdeco-button--primary'>Send</button></form></aside>",
    );
    expect(findCommentSubmit(root)).toBeNull();
  });

  it("the action-bar toggle (comment-small sprite) is never returned as the submit", () => {
    // Both the toggle and the submit read 'Comment'. The toggle is told apart
    // by its comment-small sprite; the submit lives in commentButtonSection and
    // has none. Disable the submit → the toggle must NOT be picked in its place.
    const root = mount(fx("comment-box-2026.html"));
    root.querySelector<HTMLButtonElement>("button[componentkey*='commentButtonSection']")!.disabled = true;
    expect(findCommentSubmit(root)).toBeNull();
  });

  it("a toggle stripped to just a count span is still rejected (shape rule)", () => {
    // Even with the sprite removed, a 'Comment'-aria button whose visible text
    // is only a count is the action-bar affordance, never the submit.
    const root = mount(fx("comment-box-2026.html"));
    const toggle = [...root.querySelectorAll<HTMLElement>("button[aria-label='Comment']")]
      .find((b) => b.querySelector("svg[id='comment-small']"))!;
    toggle.querySelector("svg")!.remove(); // now only aria='Comment' + <span>10</span>
    root.querySelector<HTMLButtonElement>("button[componentkey*='commentButtonSection']")!.disabled = true;
    expect(findCommentSubmit(root)).toBeNull();
  });

  it("unwrapped thread Reply (plain .comments-section) never wins — submit disabled or absent", () => {
    // The live capture's reply affordance sits in a plain div, not a
    // replaceableComment/comment-item wrapper — the bare-'Reply' word rule is
    // what keeps it out, not the wrapper heuristics.
    const root = mount(fx("comment-box-2026.html"));
    const item = root.querySelector<HTMLElement>("[componentkey='replaceableComment_1']")!;
    item.removeAttribute("componentkey");
    item.className = "comments-section";
    const submit = root.querySelector<HTMLButtonElement>("button[componentkey*='commentButtonSection']")!;
    submit.disabled = true;
    expect(findCommentSubmit(root)).toBeNull(); // disabled → wait for it to enable
    submit.remove();
    expect(findCommentSubmit(root)).toBeNull(); // absent → still never the thread Reply
  });

  it("a submit-styled 'Reply' button still qualifies (reply-branch composer shape)", () => {
    const root = mount(
      "<div class='_c'><div role='textbox' contenteditable='true'>text</div>" +
        "<button type='submit' class='_r'>Reply</button></div>",
    );
    expect(findCommentSubmit(root)?.textContent).toBe("Reply");
  });

  it("findCommentBox skips a chat pane that precedes the real composer", () => {
    // If LinkedIn ever mounts the messaging overlay BEFORE the main content,
    // the box search must step over it — not anchor typing (and the post-
    // submit confirm reads) on a DM pane.
    const root = mount(
      "<aside class='msg-overlay-list-bubble'><form class='msg-form'>" +
        "<div role='textbox' contenteditable='true' aria-label='Write a message…'></div>" +
        "<button type='submit'>Send</button></form></aside>" +
        "<div class='_9b8c7d6e'><div role='textbox' contenteditable='true' aria-label='Text editor for creating comment'></div>" +
        "<button type='submit' class='_a1b2c3'>Comment</button></div>",
    );
    const box = findCommentBox(root);
    expect(box?.getAttribute("aria-label")).toBe("Text editor for creating comment");
    expect(findCommentSubmit(root)?.className).toBe("_a1b2c3");
  });

  it("never returns ANOTHER post's hook-less toggle when the composer has no submit at all", () => {
    // Feed shape: post A's composer is open but its submit hasn't mounted;
    // post B below carries a live-capture-shaped toggle (aria 'Comment',
    // count-only text, zero SDUI hooks). It is wordy, enabled, and follows the
    // box — the count-span shape check is what rejects it.
    const root = mount(
      "<main><div class='_postA'><div role='textbox' contenteditable='true'>typed</div>" +
        "<button type='button' class='_e5f6' aria-label='Show Emoji Picker'></button></div>" +
        "<div class='_postB'><button type='button' class='_x9k2' aria-label='Comment'><span>3</span></button></div></main>",
    );
    expect(findCommentSubmit(root)).toBeNull();
  });

  it("findCommentBox skips an obfuscated chat pane by its accessible name", () => {
    // If messaging classes get hashed like the feed's were, the pane's
    // aria-label still says what it is — never anchor a comment there (typing
    // + the ⌘/Ctrl+Enter chord would deliver it as a DM).
    const both = mount(
      "<div class='_zz1'><div role='textbox' contenteditable='true' aria-label='Write a message…'></div>" +
        "<button type='submit' class='_h4x8'>Send</button></div>" +
        "<div class='_9b8c7d6e'><div role='textbox' contenteditable='true' aria-label='Text editor for creating comment'></div>" +
        "<button type='submit' class='_a1b2c3'>Comment</button></div>",
    );
    expect(findCommentBox(both)?.getAttribute("aria-label")).toBe("Text editor for creating comment");
    const paneOnly = mount(
      "<div class='_zz1'><div role='textbox' contenteditable='true' aria-label='Write a message…'></div>" +
        "<button type='submit' class='_h4x8'>Send</button></div>",
    );
    expect(findCommentBox(paneOnly)).toBeNull();
    expect(findCommentSubmit(paneOnly)).toBeNull();
  });
});

describe("commentBoxText (post-submit verification signal)", () => {
  it("returns the trimmed text of a populated composer", () => {
    const t = commentBoxText(mount("<div role='textbox' contenteditable='true'>  hi there  </div>"));
    expect(t).toBe("hi there");
  });

  it("returns '' for a cleared composer (posted)", () => {
    expect(commentBoxText(mount("<div role='textbox' contenteditable='true'></div>"))).toBe("");
  });

  it("returns '' when only zero-width space / BOM remain", () => {
    expect(commentBoxText(mount(`<div role='textbox' contenteditable='true'>${'\u200B\uFEFF'}</div>`))).toBe("");
  });

  it("returns null when there is no composer at all", () => {
    expect(commentBoxText(mount("<div>no composer</div>"))).toBeNull();
  });
});

describe("reaction flyout selectors", () => {
  it("findReactionsMenu returns the open flyout, null when closed", () => {
    expect(findReactionsMenu(mount(fx("reaction-menu.html")))).not.toBeNull();
    expect(findReactionsMenu(mount(fx("feed-post.html")))).toBeNull();
  });

  it("findReactionButton resolves each reaction by its Voyager enum", () => {
    const root = mount(fx("reaction-menu.html"));
    expect(findReactionButton(root, "PRAISE", "Celebrate")?.getAttribute("aria-label")).toBe("Celebrate");
    expect(findReactionButton(root, "EMPATHY", "Support")?.getAttribute("aria-label")).toBe("Support");
    expect(findReactionButton(root, "ENTERTAINMENT", "Funny")?.textContent).toBe("Funny");
  });

  it("findReactionButton falls back to the label word when data-reaction-type is gone", () => {
    const root = mount(`
      <div class="feed-shared-social-action-bar">
        <button aria-label="React Like to Nora Kim's post" aria-pressed="false">Like</button>
        <div class="reactions-menu">
          <button aria-label="Celebrate">Celebrate</button>
          <button aria-label="Support">Support</button>
        </div>
      </div>`);
    expect(findReactionButton(root, "EMPATHY", "Support")?.getAttribute("aria-label")).toBe("Support");
  });

  it("the label fallback never grabs the action-bar Like toggle for LIKE", () => {
    // A label-only menu with a "Like" item AND the action-bar "React Like …to
    // Nora's post" toggle: the "'s post" toggle is excluded, so LIKE resolves to
    // the flyout item, not the toggle.
    const root = mount(`
      <div class="feed-shared-social-action-bar">
        <button aria-label="React Like to Nora Kim's post" aria-pressed="false">Like</button>
        <div class="reactions-menu">
          <button aria-label="Like">Like</button>
          <button aria-label="Support">Support</button>
        </div>
      </div>`);
    const btn = findReactionButton(root, "LIKE", "Like");
    expect(btn?.getAttribute("aria-label")).toBe("Like");
    expect(btn?.getAttribute("aria-label")).not.toMatch(/'s post/);
  });

  it("findReactionButton returns null when the flyout is closed", () => {
    expect(findReactionButton(mount(fx("feed-post.html")), "PRAISE", "Celebrate")).toBeNull();
  });
});

describe("diagnoseCommentSubmit (splits the submit-not-found causes)", () => {
  const noZero = () => false; // every element has a real box
  const allZero = () => true; // every element measures zero (no layout)

  it("enabled composer submit → wf=1,en=1,vis=1 (should have been found)", () => {
    const d = diagnoseCommentSubmit(mount(fx("comment-box-2026.html")), noZero);
    expect(d).toMatchObject({ box: true, wf: 1, en: 1, vis: 1 });
    expect(d.top).toBe("Comment_ok");
  });

  it("dom descriptor captures the editor + submit state (sanitizer-safe)", () => {
    const d = diagnoseCommentSubmit(mount(fx("comment-box-2026.html")), noZero);
    // The box is div.tiptap[role=textbox] inside the tiptap wrapper → pm=1.
    expect(d.dom).toMatch(/\bbx_div\b/);
    expect(d.dom).toMatch(/\bpm_1\b/);
    expect(d.dom).toMatch(/\bnce_1\b/);
    expect(d.dom).toMatch(/\blen_\d+\b/);
    // The composer submit is enabled in the fixture → dis_false.
    expect(d.dom).toMatch(/\bdis_false\b/);
    // Only sanitizer-safe characters so it survives into the reason verbatim.
    expect(d.dom).toMatch(/^[A-Za-z0-9 _-]+$/);
  });

  it("region dump names each button's shape (pos/type/flags/group)", () => {
    const d = diagnoseCommentSubmit(mount(fx("comment-box-2026.html")), noZero);
    // The composer submit: follows the box, type=BUTTON (live shape), enabled,
    // worded, NO group (it is NOT flagged as a toggle — the bug this locks in).
    expect(d.region).toContain("Comment_fb_001_gn");
    // The action-bar toggle: precedes the box, type=button, toggle-grouped (gt).
    expect(d.region).toMatch(/Comment_pb_\d\d\d_gt/);
    // Space-separated so it survives the reason sanitizer.
    expect(d.region.split(" ").length).toBeGreaterThanOrEqual(2);
  });

  it("region exposes an icon-only (unworded) submit the counts would hide", () => {
    // The exact shape the live wf=0 row points at: a real submit that carries
    // no submit word (icon-only), so wf=0, but the region dump still shows a
    // following submit-typed button with worded=0.
    const root = mount(
      "<div class='_c'><div role='textbox' contenteditable='true'>hi</div>" +
        "<button type='submit' class='_z' aria-label='Add a comment'><svg></svg></button></div>",
    );
    const d = diagnoseCommentSubmit(root, noZero);
    expect(d.wf).toBe(0); // 'Add a comment' isn't in the exact word list
    expect(d.region).toContain("_fs_000_gn"); // …but the region shows a following submit (type=s), worded=0
  });

  it("disabled submit → wf=1,en=0 and top names it disabled (the enable-lag race)", () => {
    const root = mount(fx("comment-box-2026.html"));
    root.querySelector<HTMLButtonElement>("button[componentkey*='commentButtonSection']")!.disabled = true;
    const d = diagnoseCommentSubmit(root, noZero);
    expect(d).toMatchObject({ wf: 1, en: 0, vis: 0 });
    expect(d.top).toBe("Comment_dis");
  });

  it("enabled but zero-rect → en=1,vis=0 and top flags the layout skip", () => {
    const d = diagnoseCommentSubmit(mount(fx("comment-box-2026.html")), allZero);
    expect(d).toMatchObject({ wf: 1, en: 1, vis: 0 });
    expect(d.top).toBe("Comment_zr");
  });

  it("no composer submit, only the action-bar toggle → wf=0 and top=..._tog or _pre", () => {
    // The submit removed; the only submit-worded button left is the toggle,
    // which precedes the (now absent) composer / is toggle-classified.
    const root = mount(fx("comment-box-2026.html"));
    root.querySelector<HTMLButtonElement>("button[componentkey*='commentButtonSection']")!.remove();
    const d = diagnoseCommentSubmit(root, noZero);
    expect(d.wf).toBe(0);
    expect(d.all).toBeGreaterThanOrEqual(1); // a 'Comment' toggle still exists
    expect(["_tog", "_pre"].some((s) => d.top.endsWith(s))).toBe(true);
  });

  it("no box at all → box=false,wf=0,top=none-or-nobox", () => {
    const d = diagnoseCommentSubmit(mount("<div>nothing here</div>"), noZero);
    expect(d.box).toBe(false);
    expect(d.wf).toBe(0);
  });
});
