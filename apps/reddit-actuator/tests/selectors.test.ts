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
    const root = mount(flavor === "new"
      ? `<comment-composer-host><div contenteditable="true" name="body"></div><button slot="submit-button">Comment</button></comment-composer-host><shreddit-comment thingid="t1_target"></shreddit-comment>`
      : `<div class="thing comment" data-fullname="t1_other"><div class="child"><div class="usertext-edit"><textarea name="text"></textarea></div><div class="usertext-buttons"><button class="save">save</button></div></div></div><div class="thing comment" data-fullname="t1_target"></div>`);
    expect.soft(findReplyBox(root, flavor, "target")).toBeNull();
    expect.soft(findReplySubmit(root, flavor, "target")).toBeNull();
  });

  it.each(["new", "old"] as const)("does not select a nested child's editor or submit for the %s parent comment", (flavor) => {
    const root = mount(flavor === "new"
      ? `<shreddit-comment thingid="t1_target"><shreddit-comment thingid="t1_child"><comment-composer-host><div contenteditable="true" name="body"></div><button slot="submit-button">Comment</button></comment-composer-host></shreddit-comment></shreddit-comment>`
      : `<div class="thing comment" data-fullname="t1_target"><div class="child"><div class="thing comment" data-fullname="t1_child"><div class="child"><div class="usertext-edit"><textarea name="text"></textarea></div><div class="usertext-buttons"><button class="save">save</button></div></div></div></div></div>`);
    expect.soft(findReplyBox(root, flavor, "target")).toBeNull();
    expect.soft(findReplySubmit(root, flavor, "target")).toBeNull();
  });

  it("does not borrow the following comment's editor or submit", () => {
    const root = mount(`<shreddit-comment thingid="t1_target"></shreddit-comment><shreddit-comment thingid="t1_other"><comment-composer-host><div contenteditable="true" name="body"></div><button slot="submit-button">Comment</button></comment-composer-host></shreddit-comment>`);
    expect.soft(findReplyBox(root, "new", "target")).toBeNull();
    expect.soft(findReplySubmit(root, "new", "target")).toBeNull();
  });

  it("keeps the existing adjacent new-Reddit composer association", () => {
    const root = mount(`<shreddit-comment thingid="t1_target"></shreddit-comment><comment-composer-host><div contenteditable="true" name="body" id="target-box"></div><button slot="submit-button" id="target-submit">Comment</button></comment-composer-host>`);
    expect.soft(findReplyBox(root, "new", "target")?.id).toBe("target-box");
    expect.soft(findReplySubmit(root, "new", "target")?.id).toBe("target-submit");
  });

  it("selects the requested old-Reddit editor and submit among two distinct open comments", () => {
    const composer = (id: string) => `<div class="thing comment" data-fullname="t1_${id}"><div class="child"><div class="usertext-edit"><textarea name="text" id="${id}-box"></textarea></div><div class="usertext-buttons"><button class="save" id="${id}-submit">save</button></div></div></div>`;
    const root = mount(composer("other") + composer("target"));
    expect.soft(findReplyBox(root, "old", "target")?.id).toBe("target-box");
    expect.soft(findReplySubmit(root, "old", "target")?.id).toBe("target-submit");
  });

  it.each(["new", "old"] as const)("returns no editor or submit for an absent %s target", (flavor) => {
    const root = mount(flavor === "new"
      ? `<comment-composer-host><div contenteditable="true" name="body"></div><button slot="submit-button">Comment</button></comment-composer-host>`
      : OLD_COMPOSER);
    expect.soft(findReplyBox(root, flavor, "absent")).toBeNull();
    expect.soft(findReplySubmit(root, flavor, "absent")).toBeNull();
  });

  const SCOPED = `
    <comment-composer-host>
      <div contenteditable="true" name="body" role="textbox" id="post-box"></div>
      <button type="submit" slot="submit-button" id="post-submit">Comment</button>
    </comment-composer-host>
    <shreddit-comment thingid="t1_c1" author="alice">
      <shreddit-comment-action-row><button>Reply</button></shreddit-comment-action-row>
      <comment-composer-host>
        <div contenteditable="true" name="body" role="textbox" id="comment-box"></div>
        <button type="submit" slot="submit-button" id="comment-submit">Comment</button>
      </comment-composer-host>
    </shreddit-comment>`;

  it("scopes the reply box + submit to the TARGET comment's composer", () => {
    const root = mount(SCOPED);
    expect(findReplyBox(root, "new", "c1")!.id).toBe("comment-box");
    expect(findReplySubmit(root, "new", "c1")!.id).toBe("comment-submit");
  });
  it("without a commentId uses the page-level POST composer (first in document order)", () => {
    const root = mount(SCOPED);
    expect(findReplyBox(root, "new")!.id).toBe("post-box");
    expect(findReplySubmit(root, "new")!.id).toBe("post-submit");
  });
  it("relaxed editable selector: name='body' WITHOUT role='textbox' still matches", () => {
    const root = mount(`<div contenteditable="true" name="body" id="b"></div>`);
    expect(findReplyBox(root, "new")!.id).toBe("b");
  });

  /** jsdom lays nothing out, so a box only counts as visible when stubbed. */
  const show = (el: HTMLElement) => {
    el.getBoundingClientRect = () =>
      ({ x: 0, y: 0, width: 300, height: 80, top: 0, left: 0, right: 300, bottom: 80, toJSON: () => ({}) }) as DOMRect;
    return el;
  };

  // The clear-before-navigate path has no commentId to scope by, and the test
  // directly above is exactly why it must NOT reuse findReplyBox: unscoped, that
  // answers "where would a reply be typed" and returns the page-level POST
  // composer. If the operator has expanded that box, an EMPTY post composer
  // outranks a comment reply composer still holding text — the emptiness check
  // reads the wrong box, reports nothing to clear, and the navigation raises the
  // leave-site dialog the clear exists to prevent.
  it("findDirtyReplyBox picks the box that HOLDS TEXT, not the one findReplyBox would type into", () => {
    const root = mount(SCOPED);
    // The operator has EXPANDED the page-level post composer (so it is visible)
    // and left it empty, while a comment reply composer holds text. That is the
    // exact state in which the two questions give different answers.
    show(root.querySelector<HTMLElement>("#post-box")!);
    show(root.querySelector<HTMLElement>("#comment-box")!).textContent = "half-typed reply";
    // The trap, pinned: unscoped findReplyBox still points at the empty post box.
    expect(findReplyBox(root, "new")!.id).toBe("post-box");
    expect(findDirtyReplyBox(root, "new")!.id).toBe("comment-box");
  });

  it("findDirtyReplyBox returns null when nothing on the page holds text", () => {
    const root = mount(SCOPED);
    expect(findDirtyReplyBox(root, "new")).toBeNull();
  });

  // Without the ownership-aware search the clear gives up on the wrong box:
  // the operator's own text sits in the page-level composer, which is FIRST in
  // document order, so "the dirty box is not ours" would be the answer while
  // our leftover reply sat further down — navigating away from it and arming
  // the dialog with nothing logged.
  it("findDirtyReplyBox skips the operator's dirty box to find OURS further down", () => {
    const root = mount(SCOPED);
    show(root.querySelector<HTMLElement>("#post-box")!).textContent = "something the operator is writing";
    show(root.querySelector<HTMLElement>("#comment-box")!).textContent = "our leftover reply";
    // Unqualified, the first visible dirty box wins — the operator's.
    expect(findDirtyReplyBox(root, "new")!.id).toBe("post-box");
    // Asked for OURS, it finds ours.
    const mine = (t: string) => t.includes("our leftover reply");
    expect(findDirtyReplyBox(root, "new", mine)!.id).toBe("comment-box");
  });

  it("findDirtyReplyBox returns null when nothing on the page holds OUR text", () => {
    const root = mount(SCOPED);
    show(root.querySelector<HTMLElement>("#post-box")!).textContent = "only the operator's text";
    expect(findDirtyReplyBox(root, "new", (t) => t.includes("ours"))).toBeNull();
  });

  it("findDirtyReplyBox ignores whitespace-only text", () => {
    const root = mount(SCOPED);
    show(root.querySelector<HTMLElement>("#comment-box")!).textContent = "   \n  ";
    expect(findDirtyReplyBox(root, "new")).toBeNull();
  });

  // Taking the first dirty candidate regardless of visibility DEADLOCKS the
  // clear: the probe reports "still dirty" forever off a box the focus click can
  // never land on, so runClearComposer bails through its no-composer path and
  // the visible box actually holding a reply is never cleared at all.
  it("findDirtyReplyBox prefers a VISIBLE dirty box over a hidden one earlier in the document", () => {
    const root = mount(`
      <div contenteditable="true" name="body" role="textbox" id="hidden">stale prefill</div>
      <div contenteditable="true" name="body" role="textbox" id="shown">half-typed reply</div>`);
    show(root.querySelector<HTMLElement>("#shown")!);
    expect(findDirtyReplyBox(root, "new")!.id).toBe("shown");
  });

  // A hidden dirty box is not a fallback either. old.reddit prefills a
  // collapsed usertext-edit textarea with every one of your own comments, so
  // returning one would report the page dirty forever: the probe reads
  // present:true while the focus click can never land on a zero-rect element,
  // deadlocking the clear and logging a false "would not clear" on every hop.
  it("findDirtyReplyBox ignores a dirty box that is hidden", () => {
    const root = mount(`<div contenteditable="true" name="body" role="textbox" id="hidden">stale prefill</div>`);
    expect(findDirtyReplyBox(root, "new")).toBeNull();
  });

  it("findDirtyReplyBox ignores old Reddit's hidden prefilled comment textareas", () => {
    const root = mount(`
      <div class="thing comment"><div class="usertext-edit"><textarea name="text">my earlier comment</textarea></div></div>
      <div class="commentarea"><div class="usertext-edit"><textarea name="text"></textarea></div></div>`);
    expect(findDirtyReplyBox(root, "old")).toBeNull();
  });

  it("findDirtyReplyBox reads a value, not textContent, on old Reddit", () => {
    const root = mount(`<textarea name="text" id="t"></textarea>`);
    const ta = show(root.querySelector<HTMLTextAreaElement>("#t")!) as HTMLTextAreaElement;
    expect(findDirtyReplyBox(root, "old")).toBeNull();
    ta.value = "half-typed reply";
    expect(findDirtyReplyBox(root, "old")!.id).toBe("t");
  });
});

// ── Reply-submit locator rewrite (ports #407 + #442) ─────────────────────────
// The old fallback was a bare document-wide querySelector for
// button[slot='submit-button'] — first match wins regardless of which composer
// was typed into. These lock the anchored, word-gated, decoy-excluded search.

describe("findReplySubmit — anchored fallback + decoy rejection (ports #407/#442)", () => {
  it("DECOY: never returns the thread-level 'Reply' opener (action row) when the slot attr is missing", () => {
    // Composer whose submit lost its slot attr (drift) + a comment's Reply opener.
    const root = mount(`
      <shreddit-comment thingid="t1_x" author="a">
        <shreddit-comment-action-row><button>Reply</button></shreddit-comment-action-row>
      </shreddit-comment>
      <comment-composer-host>
        <div contenteditable="true" name="body" role="textbox"></div>
        <button type="submit" id="real">Comment</button>
      </comment-composer-host>`);
    const hit = findReplySubmit(root, "new")!;
    expect(hit.id).toBe("real");
  });
  it("DECOY: a count-only button whose aria carries the word is rejected (comment-count shape)", () => {
    const root = mount(`
      <button aria-label="Comment" id="decoy">1.2K</button>
      <comment-composer-host>
        <div contenteditable="true" name="body" role="textbox"></div>
        <button type="submit" slot="submit-button" id="real">Comment</button>
      </comment-composer-host>`);
    expect(findReplySubmit(root, "new")!.id).toBe("real");
  });
  it("ANCHOR: a worded button PRECEDING the box (toggle position) is never picked", () => {
    const root = mount(`
      <button id="before">Comment</button>
      <comment-composer-host>
        <div contenteditable="true" name="body" role="textbox"></div>
