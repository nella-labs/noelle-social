/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach } from "vitest";
import { makeRng } from "../src/lib/rng.js";
import {
  detectFlavor,
  findPost, postId, postAuthor, postScore, postTitle, postBody, postImage, postSubreddit, postHasMedia,
  findComments, commentId, commentAuthor, commentScore, mostUpvotedComment, commentReplyButton,
  findComposerEntry, findReplyBox, findDirtyReplyBox, findReplySubmit, diagnoseReplySubmit,
  findAmbientComments, findUpvoteButton, findFeedUpvoteTarget,
  findSaveButton, findSaveMenuItem, findFeedSaveTarget,
  findFeedPosts, postHasUpvoteButton, countUpvoteButtons,
  detectChallenge, isPostUnavailable, isCommentsUnavailable,
} from "../src/content/selectors.js";

function mount(html: string): HTMLElement {
  document.body.innerHTML = html;
  return document.body;
}

beforeEach(() => {
  document.body.innerHTML = "";
});

// ── NEW Reddit fixtures ──────────────────────────────────────────────────────

const NEW_POST = `
  <shreddit-post author="founder_jane" score="128"
    permalink="/r/SaaS/comments/abc123/how-we-hit-10k-mrr/" id="t3_abc123"
    post-type="image" comment-count="42" content-href="https://i.redd.it/example.jpg">
    <h1 slot="title">How we hit 10k MRR</h1>
    <div slot="text-body"><div class="md">We spent six months talking to users before writing a line of code.</div></div>
    <div slot="post-media-container"><img class="media-lightbox-img" src="https://i.redd.it/example.jpg"></div>
  </shreddit-post>`;

const NEW_COMMENTS = `
  <shreddit-comment thingid="t1_c1" author="alice" score="5" depth="0" postid="t3_abc123">
    <div slot="comment">a low-scored take</div>
    <shreddit-comment-action-row><button>Reply</button><button>Share</button></shreddit-comment-action-row>
  </shreddit-comment>
  <shreddit-comment thingid="t1_c2" author="bob" score="99" depth="0" postid="t3_abc123">
    <div slot="comment">the most upvoted comment</div>
    <shreddit-comment-action-row><button>Reply</button></shreddit-comment-action-row>
  </shreddit-comment>
  <shreddit-comment thingid="t1_c3" author="carol" score="12" depth="0" postid="t3_abc123">
    <div slot="comment">middling</div>
    <shreddit-comment-action-row><button>Reply</button></shreddit-comment-action-row>
  </shreddit-comment>`;

const NEW_COMPOSER = `
  <comment-composer-host user-id="t2_zzz">
    <faceplate-textarea-input placeholder="Add a comment"></faceplate-textarea-input>
  </comment-composer-host>
  <div contenteditable="true" name="body" role="textbox"></div>
  <button type="submit" slot="submit-button">Comment</button>`;

// ── OLD Reddit fixtures ──────────────────────────────────────────────────────

const OLD_POST = `
  <div class="thing link" data-fullname="t3_old1" data-author="olduser" data-score="256"
    data-permalink="/r/webdev/comments/old1/an-old-post/" data-url="https://i.imgur.com/x.png">
    <a class="title">An old post</a>
    <a class="thumbnail" href="https://i.imgur.com/x.png"><img></a>
    <div class="entry"><div class="usertext-body"><div class="md">old body text here for reading</div></div></div>
  </div>`;

const OLD_COMMENTS = `
  <div class="thing comment" data-fullname="t1_oc1" data-author="ol_a" data-permalink="/r/webdev/comments/old1/x/oc1/">
    <div class="entry">
      <span class="score unvoted" title="7">7 points</span>
      <ul class="flat-list buttons"><li class="reply-button"><a href="#">reply</a></li></ul>
    </div>
    <div class="child">
      <div class="thing comment" data-fullname="t1_nested" data-author="deep">
        <div class="entry"><span class="score unvoted" title="3">3 points</span></div>
      </div>
    </div>
  </div>
  <div class="thing comment" data-fullname="t1_oc2" data-author="ol_b" data-permalink="/r/webdev/comments/old1/x/oc2/">
    <div class="entry">
      <span class="score unvoted" title="88">88 points</span>
      <ul class="flat-list buttons"><li class="reply-button"><a href="#">reply</a></li></ul>
    </div>
  </div>`;

const OLD_COMPOSER = `
  <div class="commentarea">
    <div class="usertext-edit"><textarea name="text"></textarea></div>
    <div class="usertext-buttons"><button class="save">save</button><button class="cancel">cancel</button></div>
  </div>`;

// ── Flavor detection ─────────────────────────────────────────────────────────

describe("detectFlavor", () => {
  it("uses hostname old.reddit.com as the strongest signal", () => {
    expect(detectFlavor(mount(NEW_POST), "old.reddit.com")).toBe("old");
  });
  it("sniffs shreddit-* ⇒ new", () => {
    expect(detectFlavor(mount(NEW_POST), "www.reddit.com")).toBe("new");
  });
  it("sniffs .thing ⇒ old", () => {
    expect(detectFlavor(mount(OLD_POST))).toBe("old");
  });
  it("defaults to new", () => {
    expect(detectFlavor(mount("<div>nothing</div>"))).toBe("new");
  });
});

// ── Post parsing ─────────────────────────────────────────────────────────────

describe("post parsing (new Reddit)", () => {
  it("reads id/author/score/title/body/subreddit + image + media", () => {
    const root = mount(NEW_POST);
    const post = findPost(root, "new")!;
    expect(post).toBeTruthy();
    expect(postId(post, "new")).toBe("abc123"); // t3_ stripped
    expect(postAuthor(post, "new")).toBe("founder_jane");
    expect(postScore(post, "new")).toBe(128);
    expect(postTitle(post, "new")).toBe("How we hit 10k MRR");
    expect(postBody(post, "new")).toContain("six months talking to users");
    expect(postSubreddit(post, "new")).toBe("SaaS");
    expect(postImage(post, "new")).toBe("https://i.redd.it/example.jpg"); // content-href
    expect(postHasMedia(post, "new")).toBe(true);
  });
});

describe("post parsing (old Reddit)", () => {
  it("reads data-* attrs + title/body/image", () => {
    const root = mount(OLD_POST);
    const post = findPost(root, "old")!;
    expect(postId(post, "old")).toBe("old1");
    expect(postAuthor(post, "old")).toBe("olduser");
    expect(postScore(post, "old")).toBe(256);
    expect(postTitle(post, "old")).toBe("An old post");
    expect(postBody(post, "old")).toBe("old body text here for reading");
    expect(postSubreddit(post, "old")).toBe("webdev");
    expect(postImage(post, "old")).toBe("https://i.imgur.com/x.png");
    expect(postHasMedia(post, "old")).toBe(true);
  });
});

// ── Comment parsing + most-upvoted sort ──────────────────────────────────────

describe("comment parsing + most-upvoted (new Reddit)", () => {
  it("finds all comments, reads id/author/score, sorts most-upvoted", () => {
    const root = mount(NEW_COMMENTS);
    const comments = findComments(root, "new");
    expect(comments).toHaveLength(3);
    expect(commentId(comments[0]!, "new")).toBe("c1"); // t1_ stripped
    expect(commentAuthor(comments[0]!, "new")).toBe("alice");
    expect(commentScore(comments[0]!, "new")).toBe(5);
    const top = mostUpvotedComment(root, "new")!;
    expect(commentId(top, "new")).toBe("c2");
    expect(commentScore(top, "new")).toBe(99);
  });
  it("locates a comment's own Reply button by text (no aria-label)", () => {
    const root = mount(NEW_COMMENTS);
    const c1 = findComments(root, "new")[0]!;
    const btn = commentReplyButton(c1, "new")!;
    expect(btn).toBeTruthy();
    expect((btn.textContent ?? "").trim()).toBe("Reply");
  });
});

describe("comment parsing + most-upvoted (old Reddit)", () => {
  it("reads the exact score from title, scoped to the comment's OWN entry (ignores nested child)", () => {
    const root = mount(OLD_COMMENTS);
    const comments = findComments(root, "old");
    // 3 nodes total (oc1, its nested child, oc2)
    expect(comments.length).toBe(3);
    const oc1 = comments.find((c) => commentId(c, "old") === "oc1")!;
    expect(commentScore(oc1, "old")).toBe(7); // its OWN entry score, not the nested child's
    const top = mostUpvotedComment(root, "old")!;
    expect(commentId(top, "old")).toBe("oc2");
    expect(commentScore(top, "old")).toBe(88);
  });
  it("locates the reply link by text 'reply'", () => {
    const root = mount(OLD_COMMENTS);
    const oc1 = findComments(root, "old").find((c) => commentId(c, "old") === "oc1")!;
    const link = commentReplyButton(oc1, "old")!;
    expect((link.textContent ?? "").trim().toLowerCase()).toBe("reply");
  });
});

// ── Composer / reply box / submit ────────────────────────────────────────────

describe("composer + reply box + submit (new Reddit)", () => {
  it("entry is the collapsed faceplate proxy; box is the contenteditable; submit is the slotted button", () => {
    const root = mount(NEW_COMPOSER);
    expect(findComposerEntry(root, "new")!.tagName.toLowerCase()).toBe("faceplate-textarea-input");
    const box = findReplyBox(root, "new")!;
    expect(box.getAttribute("contenteditable")).toBe("true");
    expect(box.getAttribute("name")).toBe("body");
    expect(findReplySubmit(root, "new")!.getAttribute("slot")).toBe("submit-button");
  });
});

describe("findReplyBox / findReplySubmit — new-Reddit comment scoping (FIX 2)", () => {
  it.each(["new", "old"] as const)("refuses another composer's editor and submit when the requested %s comment has no composer", (flavor) => {
