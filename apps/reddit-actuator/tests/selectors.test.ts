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
        <button id="after">Comment</button>
      </comment-composer-host>`);
    expect(findReplySubmit(root, "new")!.id).toBe("after");
  });
  it("WAIT-NEVER-WIDEN: a disabled real submit is returned (→ reply-submit-disabled) over an enabled decoy elsewhere", () => {
    const root = mount(`
      <comment-composer-host>
        <div contenteditable="true" name="body" role="textbox"></div>
        <button type="submit" slot="submit-button" disabled id="real">Comment</button>
      </comment-composer-host>
      <div><button id="decoy">Post</button></div>`);
    // The climb resolves at the composer level and returns the DISABLED real
    // submit — the locator reports reply-submit-disabled and the background
    // waits; it must never widen to the enabled bare-word decoy outside.
    expect(findReplySubmit(root, "new")!.id).toBe("real");
  });
  it("WORD GATE: a non-worded, non-slotted button never qualifies", () => {
    const root = mount(`
      <div contenteditable="true" name="body" role="textbox"></div>
      <button>Share</button><button>Award</button>`);
    expect(findReplySubmit(root, "new")).toBeNull();
  });
  it("bare 'Reply' qualifies only when slot/type submit-styled (hook-less opener protection)", () => {
    const root = mount(`
      <div contenteditable="true" name="body" role="textbox"></div>
      <button id="bare">Reply</button>`);
    expect(findReplySubmit(root, "new")).toBeNull();
    const root2 = mount(`
      <div contenteditable="true" name="body" role="textbox"></div>
      <button type="submit" id="styled">Reply</button>`);
    expect(findReplySubmit(root2, "new")!.id).toBe("styled");
  });
});

describe("diagnoseReplySubmit — failure-bucket telemetry (ports #444)", () => {
  const never0 = () => false; // every button "has a rect"

  it("a disabled real submit buckets as wf=1,en=0 with top=<label>_dis", () => {
    const root = mount(`
      <comment-composer-host>
        <div contenteditable="true" name="body" role="textbox"></div>
        <button type="submit" slot="submit-button" disabled>Comment</button>
      </comment-composer-host>`);
    const d = diagnoseReplySubmit(root, "new", never0);
    expect(d).toMatchObject({ box: true, wf: 1, en: 0, vis: 0, slots: 1 });
    expect(d.top).toBe("Comment_dis");
  });

  it("an enabled submit with a ZERO rect buckets as en=1,vis=0 with top=<label>_zr", () => {
    const root = mount(`
      <comment-composer-host>
        <div contenteditable="true" name="body" role="textbox"></div>
        <button type="submit" slot="submit-button">Comment</button>
      </comment-composer-host>`);
    const d = diagnoseReplySubmit(root, "new", () => true); // everything zero-rect
    expect(d).toMatchObject({ box: true, wf: 1, en: 1, vis: 0 });
    expect(d.top).toBe("Comment_zr");
  });

  it("no worded submit at all → wf=0; the only worded button is a PRECEDING toggle → top=_pre", () => {
    const root = mount(`
      <button>Comment</button>
      <div contenteditable="true" name="body" role="textbox"></div>`);
    const d = diagnoseReplySubmit(root, "new", never0);
    expect(d).toMatchObject({ box: true, wf: 0, en: 0, slots: 0 });
    expect(d.top).toBe("Comment_pre");
  });

  it("counts slotted submits inside the TARGET comment's composer scope (scoped=)", () => {
    const root = mount(`
      <comment-composer-host>
        <div contenteditable="true" name="body" role="textbox"></div>
        <button type="submit" slot="submit-button">Comment</button>
      </comment-composer-host>
      <shreddit-comment thingid="t1_c1">
        <comment-composer-host>
          <div contenteditable="true" name="body" role="textbox"></div>
          <button type="submit" slot="submit-button">Comment</button>
        </comment-composer-host>
      </shreddit-comment>`);
    const d = diagnoseReplySubmit(root, "new", never0, "c1");
    expect(d).toMatchObject({ slots: 2, scoped: 1 });
  });

  it("no composer at all → box=false, top=<label>_nobox", () => {
    const root = mount(`<button type="submit" slot="submit-button">Comment</button>`);
    const d = diagnoseReplySubmit(root, "new", never0);
    expect(d.box).toBe(false);
    expect(d.top).toBe("Comment_nobox");
  });

  it("region dump names each button's shape (pos/type/flags/group) — a disabled real submit", () => {
    const root = mount(`
      <comment-composer-host>
        <div contenteditable="true" name="body" role="textbox"></div>
        <button type="submit" slot="submit-button" disabled>Comment</button>
      </comment-composer-host>`);
    const d = diagnoseReplySubmit(root, "new", never0);
    // FOLLOWS the box (f), slot-styled (s), disabled(1) + rect-ok(0) + worded(1),
    // no decoy group (n).
    expect(d.region).toContain("Comment_fs_101_gn");
  });

  it("region exposes a reply-opener DECOY as group=o so it can't be mistaken for the submit", () => {
    const root = mount(`
      <shreddit-comment-action-row><button>Reply</button></shreddit-comment-action-row>
      <comment-composer-host>
        <div contenteditable="true" name="body" role="textbox"></div>
        <button type="submit" slot="submit-button">Comment</button>
      </comment-composer-host>`);
    const d = diagnoseReplySubmit(root, "new", never0);
    // the action-row "Reply" PRECEDES the box (p) and is grouped as an opener (o)…
    expect(d.region).toMatch(/Reply_p._\d\d\d_go/);
    // …while the real FOLLOWING submit shows slot-styled (s), group none (n).
    expect(d.region).toContain("Comment_fs");
    expect(d.region).toContain("_gn");
  });
});

describe("chat-drawer exclusion (ports #442) — never type/submit into Reddit chat", () => {
  const CHAT = `
    <rs-message-composer>
      <div contenteditable="true" name="body" role="textbox" id="chat-box"></div>
      <button type="submit" id="chat-send">Post</button>
    </rs-message-composer>`;
  it("findReplyBox skips the chat composer entirely", () => {
    expect(findReplyBox(mount(CHAT), "new")).toBeNull();
  });
  it("findReplyBox picks the real composer even when the chat drawer mounts FIRST in the DOM", () => {
    const root = mount(CHAT + `<div contenteditable="true" name="body" role="textbox" id="real-box"></div>`);
    expect(findReplyBox(root, "new")!.id).toBe("real-box");
  });
  it("findReplySubmit never returns a chat-drawer button", () => {
    expect(findReplySubmit(mount(CHAT), "new")).toBeNull();
  });
  it("aria backstop: an editable named 'Message …' is skipped even outside known chat tags", () => {
    const root = mount(`
      <div contenteditable="true" role="textbox" aria-label="Message ada_lovelace" id="dm"></div>
      <div contenteditable="true" name="body" role="textbox" id="real-box"></div>`);
    expect(findReplyBox(root, "new")!.id).toBe("real-box");
  });
});

describe("composer + reply box + submit (old Reddit)", () => {
  it("entry === box === the visible textarea (no expand step); submit is button.save", () => {
    const root = mount(OLD_COMPOSER);
    const entry = findComposerEntry(root, "old")!;
    expect(entry.tagName.toLowerCase()).toBe("textarea");
    expect(entry.getAttribute("name")).toBe("text");
    expect(findReplyBox(root, "old")).toBe(entry);
    expect(findReplySubmit(root, "old")!.className).toContain("save");
  });
  it("prefers an open child reply box over the always-present post box", () => {
    const root = mount(`
      ${OLD_COMPOSER}
      <div class="thing comment"><div class="child">
        <div class="usertext-edit"><textarea name="text" id="child-box"></textarea></div>
        <div class="usertext-buttons"><button class="save" id="child-save">save</button></div>
      </div></div>`);
    expect(findReplyBox(root, "old")!.id).toBe("child-box");
    expect(findReplySubmit(root, "old")!.id).toBe("child-save");
  });
});

// ── Ambient decoys ───────────────────────────────────────────────────────────

describe("ambient decoys", () => {
  it("finds a post's comments link to open (old Reddit)", () => {
    const root = mount(`<div class="thing link" data-url="u"><a class="comments" href="/r/x/comments/1/">42 comments</a></div>`);
    const found = findAmbientComments(root, "old");
    expect(found).toBeTruthy();
    expect((found!.el.textContent ?? "").trim()).toBe("42 comments");
  });
});

// ── Upvote (operator opt-in; UPVOTE-ONLY, never a downvote) ──────────────────

/** Build a new-Reddit shreddit-post with its action bar in an OPEN shadow root. */
function newPostWithUpvote(opts: { pressed?: boolean; id?: string } = {}): Element {
  const post = document.createElement("shreddit-post");
  post.setAttribute("id", opts.id ?? "t3_abc123");
  post.setAttribute("permalink", "/r/SaaS/comments/abc123/how-we-hit-10k-mrr/");
  const shadow = post.attachShadow({ mode: "open" });
  shadow.innerHTML = `
    <button data-action-bar-action="upvote" aria-pressed="${opts.pressed ? "true" : "false"}">Upvote</button>
    <button data-action-bar-action="downvote" aria-pressed="false">Downvote</button>`;
  document.body.appendChild(post);
  return post;
}

describe("findUpvoteButton (UPVOTE-ONLY)", () => {
  it("new Reddit: reaches into shreddit-post's OPEN shadow root for the upvote button", () => {
    const post = newPostWithUpvote();
    const btn = findUpvoteButton(post, "new")!;
    expect(btn).toBeTruthy();
    expect(btn.getAttribute("data-action-bar-action")).toBe("upvote"); // NEVER 'downvote'
  });
  it("new Reddit: skips an already-upvoted post (aria-pressed='true')", () => {
    const post = newPostWithUpvote({ pressed: true });
    expect(findUpvoteButton(post, "new")).toBeNull();
  });
  it("old Reddit: returns the un-modded up arrow (never the down arrow)", () => {
    const root = mount(`<div class="thing link"><div class="arrow up"></div><div class="arrow down"></div></div>`);
    const btn = findUpvoteButton(root.querySelector(".thing.link")!, "old")!;
    expect(btn.className).toContain("up");
    expect(btn.className).not.toContain("down");
  });
  it("old Reddit: skips an already-upvoted arrow (.arrow.up.upmod)", () => {
    const root = mount(`<div class="thing link"><div class="arrow up upmod"></div><div class="arrow down"></div></div>`);
    expect(findUpvoteButton(root.querySelector(".thing.link")!, "old")).toBeNull();
  });
});

describe("findFeedUpvoteTarget (first NOT-already-upvoted post)", () => {
  it("old Reddit: returns the first post whose up arrow is un-modded", () => {
    const root = mount(`
      <div class="thing link" data-fullname="t3_a"><div class="arrow up upmod"></div></div>
      <div class="thing link" data-fullname="t3_b"><div class="arrow up"></div></div>`);
    const found = findFeedUpvoteTarget(root, "old")!;
    expect(found).toBeTruthy();
    expect(found.post.getAttribute("data-fullname")).toBe("t3_b"); // skipped the already-upvoted t3_a
  });
  it("old Reddit: null when every post is already upvoted", () => {
    const root = mount(`<div class="thing link"><div class="arrow up upmod"></div></div>`);
    expect(findFeedUpvoteTarget(root, "old")).toBeNull();
  });
  it("new Reddit: skips an already-upvoted post and returns the next upvotable one (shadow iteration)", () => {
    document.body.innerHTML = "";
    newPostWithUpvote({ pressed: true, id: "t3_a" });
    newPostWithUpvote({ pressed: false, id: "t3_b" });
    const found = findFeedUpvoteTarget(document.body, "new")!;
    expect(found).toBeTruthy();
    expect(found.post.getAttribute("id")).toBe("t3_b");
  });

  it("with an rng, picks a RANDOM upvotable post — not pinned to the topmost (ports #429)", () => {
    const root = mount(`
      <div class="thing link" data-fullname="t3_a"><div class="arrow up"></div></div>
      <div class="thing link" data-fullname="t3_b"><div class="arrow up"></div></div>
      <div class="thing link" data-fullname="t3_c"><div class="arrow up upmod"></div></div>
      <div class="thing link" data-fullname="t3_d"><div class="arrow up"></div></div>`);
    const picks = new Set<string>();
    for (let seed = 1; seed <= 24; seed++) {
      const found = findFeedUpvoteTarget(root, "old", makeRng(seed))!;
      expect(found).toBeTruthy();
      const name = found.post.getAttribute("data-fullname")!;
      expect(name).not.toBe("t3_c"); // the already-upvoted post is never a candidate
      picks.add(name);
    }
    expect(picks.size).toBeGreaterThan(1); // spread across candidates, not first-match
  });

  // ── In-view filter (ports LinkedIn locateLikeTarget's viewport restriction) ──
  // After ambient scrolling the feed DOM holds pages of posts; a uniform pick
  // over ALL of them regularly lands pages off-screen and the caller's
  // scrollIntoView executes an instantaneous multi-page teleport with zero wheel
  // gestures — a bot fingerprint (the class #429 removes). The random pick must
  // therefore be restricted to posts in/just-below the viewport, falling back to
  // every candidate only when none is in view.
  function stubTop(el: Element, top: number): void {
    (el as HTMLElement).getBoundingClientRect = () =>
      ({ top, bottom: top + 100, left: 0, right: 100, x: 0, y: top, width: 100, height: 100, toJSON: () => ({}) }) as DOMRect;
  }

  it("random pick NEVER lands an off-screen post while one is in view (the multi-page scroll-teleport regression)", () => {
    const root = mount(`
      <div class="thing link" data-fullname="t3_above"><div class="arrow up"></div></div>
      <div class="thing link" data-fullname="t3_inview"><div class="arrow up"></div></div>
      <div class="thing link" data-fullname="t3_below1"><div class="arrow up"></div></div>
      <div class="thing link" data-fullname="t3_below2"><div class="arrow up"></div></div>`);
    // jsdom viewport: window.innerHeight = 768 → in-view band is (-200, ~1075).
    stubTop(root.querySelector('[data-fullname="t3_above"]')!, -3000); // pages scrolled past
    stubTop(root.querySelector('[data-fullname="t3_inview"]')!, 300); // on screen
    stubTop(root.querySelector('[data-fullname="t3_below1"]')!, 5000); // pages below
    stubTop(root.querySelector('[data-fullname="t3_below2"]')!, 9000); // pages below
    for (let seed = 1; seed <= 32; seed++) {
      const found = findFeedUpvoteTarget(root, "old", makeRng(seed))!;
      expect(found.post.getAttribute("data-fullname")).toBe("t3_inview");
    }
  });

  it("counts a post just below the fold (top < 1.4×viewport) as in view, like the LinkedIn reference", () => {
    const root = mount(`
      <div class="thing link" data-fullname="t3_far"><div class="arrow up"></div></div>
      <div class="thing link" data-fullname="t3_near"><div class="arrow up"></div></div>`);
    stubTop(root.querySelector('[data-fullname="t3_far"]')!, 5000);
    stubTop(root.querySelector('[data-fullname="t3_near"]')!, 900); // just below the fold, within 1.4×768
    for (let seed = 1; seed <= 16; seed++) {
      const found = findFeedUpvoteTarget(root, "old", makeRng(seed))!;
      expect(found.post.getAttribute("data-fullname")).toBe("t3_near");
    }
  });

  it("falls back to ALL candidates when none is in view (never returns null just because the feed scrolled on)", () => {
    const root = mount(`
      <div class="thing link" data-fullname="t3_a"><div class="arrow up"></div></div>
      <div class="thing link" data-fullname="t3_b"><div class="arrow up"></div></div>`);
    stubTop(root.querySelector('[data-fullname="t3_a"]')!, 5000);
    stubTop(root.querySelector('[data-fullname="t3_b"]')!, 9000);
    const found = findFeedUpvoteTarget(root, "old", makeRng(3));
    expect(found).toBeTruthy(); // fallback pool = every candidate
  });

  it("an already-upvoted post is never picked even when it is the only one in view", () => {
    const root = mount(`
      <div class="thing link" data-fullname="t3_voted"><div class="arrow up upmod"></div></div>
      <div class="thing link" data-fullname="t3_fresh"><div class="arrow up"></div></div>`);
    stubTop(root.querySelector('[data-fullname="t3_voted"]')!, 300); // in view but already upvoted
    stubTop(root.querySelector('[data-fullname="t3_fresh"]')!, 5000); // off-screen but upvotable
    for (let seed = 1; seed <= 8; seed++) {
      const found = findFeedUpvoteTarget(root, "old", makeRng(seed))!;
      expect(found.post.getAttribute("data-fullname")).toBe("t3_fresh");
    }
  });
});

describe("upvote skip diagnostics helpers (ports #410)", () => {
  it("findFeedPosts counts feed containers per flavor", () => {
    document.body.innerHTML = "";
    newPostWithUpvote({ id: "t3_a" });
    newPostWithUpvote({ id: "t3_b" });
    expect(findFeedPosts(document.body, "new")).toHaveLength(2);
    const old = mount(`<div class="thing link"></div><div class="thing link"></div><div class="thing comment"></div>`);
    expect(findFeedPosts(old, "old")).toHaveLength(2); // comments never count as feed posts
  });
  it("postHasUpvoteButton is pressed-state-agnostic (unlike findUpvoteButton)", () => {
    document.body.innerHTML = "";
    const pressed = newPostWithUpvote({ pressed: true });
    expect(findUpvoteButton(pressed, "new")).toBeNull(); // already upvoted → no target
    expect(postHasUpvoteButton(pressed, "new")).toBe(true); // …but the button EXISTS
    const old = mount(`<div class="thing link"><div class="arrow up upmod"></div></div>`);
    expect(postHasUpvoteButton(old.querySelector(".thing.link")!, "old")).toBe(true);
  });
  it("countUpvoteButtons reaches shreddit-post shadow roots and counts light-DOM buttons once", () => {
    document.body.innerHTML = "";
    newPostWithUpvote({ id: "t3_a" });
    newPostWithUpvote({ pressed: true, id: "t3_b" });
    expect(countUpvoteButtons(document.body, "new")).toBe(2); // downvote buttons NEVER counted
    const old = mount(`<div class="thing link"><div class="arrow up"></div><div class="arrow down"></div></div>`);
    expect(countUpvoteButtons(old, "old")).toBe(1);
  });
});

// ── Save (operator opt-in; DEFAULT-OFF; SAVE-ONLY, never a vote) ──────────────

/** Build a new-Reddit shreddit-post with its overflow "…" menu opener in an OPEN
 *  shadow root (same shadow reach as the upvote fixture). */
function newPostWithSave(opts: { saved?: boolean; id?: string } = {}): Element {
  const post = document.createElement("shreddit-post");
  post.setAttribute("id", opts.id ?? "t3_abc123");
  post.setAttribute("permalink", "/r/SaaS/comments/abc123/how-we-hit-10k-mrr/");
  if (opts.saved) post.setAttribute("saved", ""); // boolean attr ⇒ already saved
  const shadow = post.attachShadow({ mode: "open" });
  shadow.innerHTML = `
    <button data-action-bar-action="upvote" aria-pressed="false">Upvote</button>
    <button data-action-bar-action="overflow" aria-label="more options">…</button>`;
  document.body.appendChild(post);
  return post;
}

describe("findSaveButton (SAVE-ONLY, never a vote)", () => {
  it("new Reddit: reaches into shreddit-post's OPEN shadow root for the overflow menu opener", () => {
    const post = newPostWithSave();
    const btn = findSaveButton(post, "new")!;
    expect(btn).toBeTruthy();
    expect(btn.getAttribute("data-action-bar-action")).toBe("overflow"); // the "…" opener, NEVER a vote arrow
  });
  it("new Reddit: skips an already-saved post (the `saved` boolean attribute) — never re-save", () => {
    const post = newPostWithSave({ saved: true });
    expect(findSaveButton(post, "new")).toBeNull();
  });
  it("new Reddit: null when no overflow affordance is present (caller falls back to upvote)", () => {
    const post = document.createElement("shreddit-post");
    post.setAttribute("id", "t3_nobtn");
    post.attachShadow({ mode: "open" }).innerHTML = `<button data-action-bar-action="upvote"></button>`;
    document.body.appendChild(post);
    expect(findSaveButton(post, "new")).toBeNull();
  });
  it("old Reddit: returns the direct .save-button link whose text is 'save'", () => {
    const root = mount(`<div class="thing link"><form class="save-button"><a href="#">save</a></form></div>`);
    const btn = findSaveButton(root.querySelector(".thing.link")!, "old")!;
    expect(btn).toBeTruthy();
    expect((btn.textContent ?? "").trim().toLowerCase()).toBe("save");
  });
  it("old Reddit: skips an already-saved link (text is 'unsave')", () => {
    const root = mount(`<div class="thing link"><form class="save-button"><a href="#">unsave</a></form></div>`);
    expect(findSaveButton(root.querySelector(".thing.link")!, "old")).toBeNull();
  });
  it("old Reddit: skips a .thing.link that already carries .saved", () => {
    const root = mount(`<div class="thing link saved"><form class="save-button"><a href="#">save</a></form></div>`);
    expect(findSaveButton(root.querySelector(".thing.link")!, "old")).toBeNull();
  });
  it("old Reddit: null when there is no save affordance at all", () => {
    const root = mount(`<div class="thing link"><a class="title">no save here</a></div>`);
    expect(findSaveButton(root.querySelector(".thing.link")!, "old")).toBeNull();
  });
});

describe("findSaveMenuItem (open overflow menu — exact 'Save' word, never Saved/Unsave)", () => {
  it("finds the Save menuitem by exact word", () => {
    const root = mount(`
      <div role="menu">
        <div role="menuitem">Share</div>
        <div role="menuitem">Save</div>
        <div role="menuitem">Hide</div>
      </div>`);
    const item = findSaveMenuItem(root)!;
    expect(item).toBeTruthy();
    expect((item.textContent ?? "").trim()).toBe("Save");
  });
  it("never matches 'Saved' or 'Unsave' (the already-saved states)", () => {
    const root = mount(`
      <div role="menu">
        <div role="menuitem">Saved</div>
        <div role="menuitem">Unsave</div>
      </div>`);
    expect(findSaveMenuItem(root)).toBeNull();
  });
  it("prefers the stable data-action-bar-action='save' hook when present", () => {
    const root = mount(`
      <div role="menu">
        <button data-action-bar-action="save" aria-label="Save">Save post</button>
      </div>`);
    const item = findSaveMenuItem(root)!;
    expect(item.getAttribute("data-action-bar-action")).toBe("save");
  });
  it("returns null when no menu is open", () => {
    expect(findSaveMenuItem(mount(`<div>no menu here</div>`))).toBeNull();
  });
});

describe("findFeedSaveTarget (first/ random NOT-already-saved post)", () => {
  it("old Reddit: returns the first post whose save link is available", () => {
    const root = mount(`
      <div class="thing link saved" data-fullname="t3_a"><form class="save-button"><a href="#">save</a></form></div>
      <div class="thing link" data-fullname="t3_b"><form class="save-button"><a href="#">save</a></form></div>`);
    const found = findFeedSaveTarget(root, "old")!;
    expect(found).toBeTruthy();
    expect(found.post.getAttribute("data-fullname")).toBe("t3_b"); // skipped the already-saved t3_a
  });
  it("old Reddit: null when every post is already saved", () => {
    const root = mount(`<div class="thing link saved"><form class="save-button"><a href="#">save</a></form></div>`);
    expect(findFeedSaveTarget(root, "old")).toBeNull();
  });
  it("new Reddit: skips an already-saved post and returns the next saveable one (shadow iteration)", () => {
    document.body.innerHTML = "";
    newPostWithSave({ saved: true, id: "t3_a" });
    newPostWithSave({ saved: false, id: "t3_b" });
    const found = findFeedSaveTarget(document.body, "new")!;
    expect(found).toBeTruthy();
    expect(found.post.getAttribute("id")).toBe("t3_b");
  });
});

// Drifted markup: EVERY feed-post container selector misses (the tag/attrs were
// renamed to xyz-*), but the upvote affordances survive in the light DOM. Post
// containers must be recovered by climbing from those buttons (ports the
// linkedin/x findFeedPosts drift fallback) so a live `posts=0` skip can't happen
// while upvote buttons plainly exist (the state countUpvoteButtons only DETECTS).
const DRIFTED_NEW = `
  <div class="xyz-feed">
    <div class="xyz-card">
      <article class="xyz-post" xyz-id="t3_aaa">
        <h3>post one survived the wrapper drift</h3>
        <div class="xyz-actions">
          <button data-action-bar-action="upvote" aria-pressed="false">Upvote</button>
          <button data-action-bar-action="downvote" aria-pressed="false">Downvote</button>
        </div>
      </article>
    </div>
    <div class="xyz-card">
      <article class="xyz-post" xyz-id="t3_bbb">
        <h3>post two is already upvoted</h3>
        <div class="xyz-actions">
          <button data-action-bar-action="upvote" aria-pressed="true">Upvote</button>
          <button data-action-bar-action="downvote" aria-pressed="false">Downvote</button>
        </div>
      </article>
    </div>
  </div>`;

const DRIFTED_OLD = `
  <div class="xyz-oldfeed">
    <div class="xyz-thing" data-fullname="t3_o1">
      <div class="xyz-mid"><div class="arrow up"></div><div class="arrow down"></div></div>
    </div>
    <div class="xyz-thing" data-fullname="t3_o2">
      <div class="xyz-mid"><div class="arrow up upmod"></div><div class="arrow down"></div></div>
    </div>
  </div>`;

describe("findFeedPosts — drift-resistant fallback (container tag/attrs renamed)", () => {
  it("new Reddit: recovers feed posts from their upvote buttons when shreddit-post is gone", () => {
    const root = mount(DRIFTED_NEW);
    expect(document.querySelectorAll("shreddit-post").length).toBe(0); // the primary selector finds nothing…
    const posts = findFeedPosts(root, "new"); // …but the fallback climbs from the 2 light-DOM upvote buttons.
    expect(posts).toHaveLength(2);
    // Each climbed container is post-sized: it wraps exactly one upvote affordance.
    for (const p of posts) expect(countUpvoteButtons(p, "new")).toBe(1);
  });

  it("new Reddit: findFeedUpvoteTarget still resolves an upvotable (not already-pressed) post via the fallback", () => {
    const root = mount(DRIFTED_NEW);
    const found = findFeedUpvoteTarget(root, "new")!;
    expect(found).toBeTruthy();
    expect(found.el.getAttribute("data-action-bar-action")).toBe("upvote"); // NEVER 'downvote'
    expect(found.el.getAttribute("aria-pressed")).toBe("false"); // skipped the already-upvoted post
  });

  it("old Reddit: recovers feed posts from their up arrows when .thing.link is gone", () => {
    const root = mount(DRIFTED_OLD);
    expect(document.querySelectorAll(".thing.link").length).toBe(0);
    const posts = findFeedPosts(root, "old");
    expect(posts).toHaveLength(2); // both the fresh AND the already-upvoted post are feed posts
    for (const p of posts) expect(countUpvoteButtons(p, "old")).toBe(1);
  });

  it("old Reddit: findFeedUpvoteTarget resolves the un-modded arrow via the fallback (never the down arrow)", () => {
    const root = mount(DRIFTED_OLD);
    const found = findFeedUpvoteTarget(root, "old")!;
    expect(found).toBeTruthy();
    expect(found.el.className).toContain("up");
    expect(found.el.className).not.toContain("down");
    expect(found.el.className).not.toContain("upmod"); // skipped the already-upvoted post
  });

  it("does NOT fire the fallback when the container selector matches (healthy markup keeps shreddit-post)", () => {
    document.body.innerHTML = "";
    newPostWithUpvote({ id: "t3_a" });
    newPostWithUpvote({ id: "t3_b" });
    const posts = findFeedPosts(document.body, "new");
    expect(posts).toHaveLength(2);
    for (const p of posts) expect(p.tagName.toLowerCase()).toBe("shreddit-post");
  });
});

// ── Challenge / throttle detection ───────────────────────────────────────────

describe("detectChallenge", () => {
  it("HARD throttle: 'you're doing that too much' in an alert region halts", () => {
    const root = mount(`<div class="ratelimit">You're doing that too much. Try again in 5 minutes.</div>`);
    expect(detectChallenge(root)).toEqual({ challenge: true, kind: "throttle" });
  });

  it("HARD verify: a human-verification wall (no real content) halts", () => {
    const root = mount(`<div class="interstitial">Please verify you are human to continue.</div>`);
    expect(detectChallenge(root)).toEqual({ challenge: true, kind: "verify" });
  });

  it("TRANSIENT js-challenge (title 'just a moment') is NOT a hard challenge", () => {
    const root = mount(`<shreddit-post author="a" score="1" id="t3_x"></shreddit-post>`);
    expect(detectChallenge(root, { title: "Just a moment..." })).toEqual({ challenge: false, kind: "jschallenge" });
  });

  it("TRANSIENT js-challenge (js_challenge=1 in url) is NOT a hard challenge", () => {
    const root = mount(`<div></div>`);
    expect(detectChallenge(root, { url: "https://www.reddit.com/?js_challenge=1" })).toEqual({
      challenge: false,
      kind: "jschallenge",
    });
  });

  it("TRANSIENT js-challenge (reputation-recaptcha element) is NOT a hard challenge", () => {
    const root = mount(`<reputation-recaptcha></reputation-recaptcha>`);
    expect(detectChallenge(root)).toEqual({ challenge: false, kind: "jschallenge" });
  });

  it("a clean thread is no challenge", () => {
    const root = mount(NEW_POST + NEW_COMMENTS);
    expect(detectChallenge(root, { title: "How we hit 10k MRR : r/SaaS" })).toEqual({ challenge: false });
  });

  it("SAFETY: throttle text inside a POST BODY does NOT false-trip a halt", () => {
    const root = mount(`
      <shreddit-post author="a" score="1" id="t3_x">
        <div slot="text-body"><div class="md">a mod once told me "you're doing that too much" lol, try again in 5 minutes he said</div></div>
      </shreddit-post>`);
    expect(detectChallenge(root)).toEqual({ challenge: false });
  });

  // ── Structural signals (ports #406): vendor iframes + interstitial routes ──

  it("STRUCTURAL: an hCaptcha vendor iframe halts even with no matching prose", () => {
    const root = mount(`<div><iframe src="https://newassets.hcaptcha.com/captcha/v1/frame"></iframe></div>`);
    expect(detectChallenge(root)).toEqual({ challenge: true, kind: "verify" });
  });

  it("STRUCTURAL: a Google reCAPTCHA vendor iframe halts", () => {
    const root = mount(`<div><iframe src="https://www.google.com/recaptcha/api2/anchor?k=x"></iframe></div>`);
    expect(detectChallenge(root)).toEqual({ challenge: true, kind: "verify" });
  });

  it("STRUCTURAL: a verification interstitial ROUTE halts (anchored to path start)", () => {
    const root = mount(`<div>some unrecognized wording</div>`);
    expect(detectChallenge(root, { url: "https://www.reddit.com/verification/step1" })).toEqual({
      challenge: true,
      kind: "verify",
    });
  });

  it("PRECISION: an ad iframe with 'captcha' in a query param does NOT halt", () => {
    const root = mount(
      NEW_POST + `<iframe src="https://ads.example.com/frame?tag=captcha&campaign=recaptcha-solver"></iframe>`,
    );
    expect(detectChallenge(root)).toEqual({ challenge: false });
  });

  it("PRECISION: a post slug containing 'blocked' does NOT halt (path check is anchored)", () => {
    const root = mount(NEW_POST);
    expect(
      detectChallenge(root, { url: "https://www.reddit.com/r/SaaS/comments/abc123/blocked_by_google_now_what/" }),
    ).toEqual({ challenge: false });
  });

  it("PRECISION: a reCAPTCHA iframe INSIDE reputation-recaptcha stays a soft jschallenge", () => {
    const root = mount(
      `<reputation-recaptcha><iframe src="https://www.google.com/recaptcha/api2/anchor?k=x"></iframe></reputation-recaptcha>`,
    );
    expect(detectChallenge(root)).toEqual({ challenge: false, kind: "jschallenge" });
  });
});

// ── Post availability (removed / deleted / 404 skip gate) ─────────────────────

// The live bug: navigating to a filter-removed post shows a removal banner AND
// still mounts a reply composer, so the actuator opened it and typed the draft.
// This fixture reproduces BOTH — a shreddit-post shell whose body is the removal
// notice, plus a live composer.
const NEW_REMOVED = `
  <main>
    <shreddit-post id="t3_dead" permalink="/r/SaaS/comments/dead/removed/">
      <h1 slot="title">[ Removed by Reddit ]</h1>
      <div slot="text-body"><div class="md">Sorry, this post was removed by Reddit's filters.</div></div>
    </shreddit-post>
    <comment-composer-host>
      <faceplate-textarea-input placeholder="Add a comment"></faceplate-textarea-input>
    </comment-composer-host>
    <div contenteditable="true" name="body" role="textbox"></div>
    <button type="submit" slot="submit-button">Comment</button>
  </main>`;

describe("isPostUnavailable (removed / deleted / 404 skip gate)", () => {
  it("new Reddit: 'removed by Reddit's filters' banner ⇒ unavailable (the screenshot case)", () => {
    const root = mount(NEW_REMOVED);
    const r = isPostUnavailable(root, "new");
    expect(r.unavailable).toBe(true);
    expect(r.reason).toBe("removed by reddit's filters");
    expect(r.positive).toBe(true); // matched removal phrase ⇒ durable skip allowed
    // Reproduction: a composer IS present on this dead post — the pre-fix code
    // would have opened it and typed. The removed gate is what now prevents that.
    expect(findComposerEntry(root, "new")).not.toBeNull();
  });

  it("new Reddit: a healthy shreddit-post + comments ⇒ available", () => {
    const root = mount(NEW_POST + NEW_COMMENTS);
    expect(isPostUnavailable(root, "new").unavailable).toBe(false);
  });

  it("new Reddit: a DELETED COMMENT in a live thread does NOT false-trip post-removed", () => {
    const root = mount(
      NEW_POST +
        `<shreddit-comment thingid="t1_d" author="[deleted]">
          <div slot="comment">[removed]</div>
          <shreddit-comment-action-row><button>Reply</button></shreddit-comment-action-row>
        </shreddit-comment>`,
    );
    expect(isPostUnavailable(root, "new").unavailable).toBe(false);
  });

  it("new Reddit: no shreddit-post at all (404 / interstitial) ⇒ unavailable", () => {
    const root = mount(`<main><h1>Sorry, nobody on Reddit goes here.</h1><p>Page not found</p></main>`);
    const r = isPostUnavailable(root, "new");
    expect(r.unavailable).toBe(true);
    expect(r.positive).toBe(true); // "page not found" is a matched removal phrase
  });

  it("new Reddit: a removed/deleted indicator ATTRIBUTE is positive removal evidence", () => {
    const root = mount(
      `<main><shreddit-post id="t3_rm" removed-by-category="moderator" permalink="/r/x/comments/rm/y/"><h1 slot="title">t</h1></shreddit-post></main>`,
    );
    const r = isPostUnavailable(root, "new");
    expect(r.unavailable).toBe(true);
    expect(r.reason).toBe("removed-attr");
    expect(r.positive).toBe(true);
  });

  it("REGRESSION: a transient error interstitial (shell absent, NO removal phrase) is post-absent and NOT positive", () => {
    // Reddit 5xx / CDN error pages render "something went wrong" with no
    // shreddit-post while the content script still runs. Pre-fix, the durable
    // markSkipped path treated this like a confirmed removal and permanently
    // discarded a human-approved reply. It must stay a NON-positive signal so the
    // background keeps it session-local (self-heals next run).
    const root = mount(`<main><h1>Sorry, something went wrong.</h1><p>Try again later.</p></main>`);
    const r = isPostUnavailable(root, "new");
    expect(r.unavailable).toBe(true);
    expect(r.reason).toBe("post-absent");
    expect(r.positive).toBeFalsy();
  });

  it("new Reddit: a typographic (curly) apostrophe in the removal banner still matches", () => {
    const root = mount(
      `<main><shreddit-post id="t3_x"><div slot="text-body"><div class="md">This post was removed by Reddit’s filters.</div></div></shreddit-post></main>`,
    );
    expect(isPostUnavailable(root, "new").unavailable).toBe(true);
  });

  it("old Reddit: .thing.link.deleted ⇒ unavailable", () => {
    const root = mount(`<div class="thing link deleted" data-fullname="t3_dead"><a class="title">[deleted]</a></div>`);
    const r = isPostUnavailable(root, "old");
    expect(r.unavailable).toBe(true);
    expect(r.reason).toBe("thing-deleted");
    expect(r.positive).toBe(true); // structural class ⇒ durable skip allowed
  });

  it("REGRESSION: old Reddit age-gate interstitial (no .thing, no removal phrase) is post-absent and NOT positive", () => {
    // The over-18 interstitial renders no `.thing` while the content script runs
    // fine. It must not be treated as confirmed removal — a durable skip here
    // would permanently discard an approved reply to a healthy NSFW-gated thread.
    const root = mount(
      `<div class="content"><h1>You must be 18+ to view this community</h1>
       <button>Yes, I am over eighteen</button><button>No, I am not</button></div>`,
    );
    const r = isPostUnavailable(root, "old");
    expect(r.unavailable).toBe(true);
    expect(r.reason).toBe("post-absent");
    expect(r.positive).toBeFalsy();
  });

  it("old Reddit: a healthy post ⇒ available", () => {
    const root = mount(OLD_POST);
    expect(isPostUnavailable(root, "old").unavailable).toBe(false);
  });

  it("old Reddit: a [removed] post body ⇒ unavailable", () => {
    const root = mount(`
      <div class="thing link" data-fullname="t3_r" data-permalink="/r/x/comments/r/y/">
        <a class="title">A removed selfpost</a>
        <div class="entry"><div class="usertext-body"><div class="md">[removed]</div></div></div>
      </div>`);
    const r = isPostUnavailable(root, "old");
    expect(r.unavailable).toBe(true);
    expect(r.positive).toBe(true); // whole-field marker ⇒ durable skip allowed
  });

  it("FALSE-POSITIVE guard: a post BODY merely QUOTING '[removed]'/'[deleted]' does NOT trip (new Reddit)", () => {
    // The bracket tokens are whole-field markers; as substrings they'd let a
    // healthy meta-post about deletion feed the DURABLE markSkipped path.
    const root = mount(
      `<shreddit-post id="t3_meta" permalink="/r/x/comments/meta/y/">
        <h1 slot="title">Why do I see [deleted] and [removed] all over old threads?</h1>
        <div slot="text-body"><div class="md">Half the comments just say [removed]. Is that mods or the user?</div></div>
      </shreddit-post>` + NEW_COMMENTS,
    );
    expect(isPostUnavailable(root, "new").unavailable).toBe(false);
  });

  it("FALSE-POSITIVE guard: an old-Reddit TITLE containing '[deleted]' as a substring does NOT trip", () => {
    const root = mount(`
      <div class="thing link" data-fullname="t3_q" data-permalink="/r/x/comments/q/y/">
        <a class="title">TIL what [deleted] actually means on reddit</a>
        <div class="entry"><div class="usertext-body"><div class="md">Genuinely curious about the difference.</div></div></div>
      </div>`);
    expect(isPostUnavailable(root, "old").unavailable).toBe(false);
  });
});

describe("isCommentsUnavailable (locked thread / archived post skip gate)", () => {
  it("new Reddit: the shreddit-post `locked` boolean attribute ⇒ blocked (comments-locked)", () => {
    // Boolean attribute: present with an EMPTY value means locked.
    const root = mount(`<shreddit-post id="t3_l" locked permalink="/r/x/comments/l/y/"><h1 slot="title">t</h1></shreddit-post>`);
    const r = isCommentsUnavailable(root, "new");
    expect(r.blocked).toBe(true);
    expect(r.reason).toBe("comments-locked");
  });

  it("new Reddit: the shreddit-post `archived` attribute ⇒ blocked (post-archived)", () => {
    const root = mount(`<shreddit-post id="t3_a" archived="" permalink="/r/x/comments/a/y/"><h1 slot="title">t</h1></shreddit-post>`);
    const r = isCommentsUnavailable(root, "new");
    expect(r.blocked).toBe(true);
    expect(r.reason).toBe("post-archived");
  });

  it("new Reddit: locked=\"false\" is an explicit negation ⇒ NOT blocked", () => {
    const root = mount(`<shreddit-post id="t3_f" locked="false"><h1 slot="title">t</h1></shreddit-post>`);
    expect(isCommentsUnavailable(root, "new").blocked).toBe(false);
  });

  it("new Reddit: a lock banner in alert chrome (no attribute) ⇒ blocked (comments-locked)", () => {
    const root = mount(
      `<shreddit-post id="t3_b"><h1 slot="title">t</h1></shreddit-post>
       <div role="alert">Locked post. New comments cannot be posted.</div>`,
    );
    const r = isCommentsUnavailable(root, "new");
    expect(r.blocked).toBe(true);
    expect(r.reason).toBe("comments-locked");
  });

  it("new Reddit: an archived banner wins the archived-specific reason", () => {
    const root = mount(
      `<shreddit-post id="t3_c"><h1 slot="title">t</h1></shreddit-post>
       <faceplate-banner>This post is archived. New comments cannot be posted and votes cannot be cast.</faceplate-banner>`,
    );
    const r = isCommentsUnavailable(root, "new");
    expect(r.blocked).toBe(true);
    expect(r.reason).toBe("post-archived");
  });

  it("a healthy new-Reddit thread ⇒ NOT blocked", () => {
    expect(isCommentsUnavailable(mount(NEW_POST + NEW_COMMENTS), "new").blocked).toBe(false);
  });

  it("FALSE-POSITIVE guard: a post BODY merely quoting the lock banner does NOT trip", () => {
    const root = mount(
      `<shreddit-post id="t3_q" permalink="/r/x/comments/q/y/">
        <h1 slot="title">Mods locked my thread</h1>
        <div slot="text-body"><div class="md">It just says "Comments are locked" and "This thread has been locked by the moderators". This post is archived nowhere, to be clear.</div></div>
      </shreddit-post>` + NEW_COMMENTS,
    );
    expect(isCommentsUnavailable(root, "new").blocked).toBe(false);
  });

  it("FALSE-POSITIVE guard: a COMMENT quoting the banner phrases does NOT trip", () => {
    const root = mount(
      NEW_POST +
        `<shreddit-comment thingid="t1_q" author="quoter">
          <div slot="comment">The banner said "new comments cannot be posted" — you won't be able to vote or comment.</div>
        </shreddit-comment>`,
    );
    expect(isCommentsUnavailable(root, "new").blocked).toBe(false);
  });

  it("old Reddit: the .thing.link.locked class ⇒ blocked (comments-locked)", () => {
    const root = mount(`<div class="thing link locked" data-fullname="t3_ol"><a class="title">locked one</a></div>`);
    const r = isCommentsUnavailable(root, "old");
    expect(r.blocked).toBe(true);
    expect(r.reason).toBe("comments-locked");
  });

  it("old Reddit: the .thing.link.archived class ⇒ blocked (post-archived)", () => {
    const root = mount(`<div class="thing link archived" data-fullname="t3_oa"><a class="title">old one</a></div>`);
    const r = isCommentsUnavailable(root, "old");
    expect(r.blocked).toBe(true);
    expect(r.reason).toBe("post-archived");
  });

  it("old Reddit: the archived .infobar phrase ⇒ blocked (post-archived)", () => {
    const root = mount(
      OLD_POST + `<div class="infobar">This is an archived post. You won't be able to vote or comment.</div>`,
    );
    const r = isCommentsUnavailable(root, "old");
    expect(r.blocked).toBe(true);
    expect(r.reason).toBe("post-archived");
  });

  it("old Reddit: a healthy post ⇒ NOT blocked", () => {
    expect(isCommentsUnavailable(mount(OLD_POST + OLD_COMMENTS), "old").blocked).toBe(false);
  });
});
