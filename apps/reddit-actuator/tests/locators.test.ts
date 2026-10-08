/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
  locateComposerEntry, locateCommentReplyButton, locateReplyBox, locateDirtyReplyBox, locateReplySubmit, readReplyBox,
  locateAmbientComments, locateUpvote, locateSave, locateSaveInMenu,
  detectChallenge, locatedCommentMatches, verifyReplyCleared,
} from "../src/content/locators.js";
import { makeRng } from "../src/lib/rng.js";
import { decideStop, readingDwellMs, glanceMs } from "../src/lib/dwell.js";

const rng = makeRng(1);

function mount(html: string): HTMLElement {
  document.body.innerHTML = html;
  return document.body;
}

/** jsdom returns an all-zero rect; stub a real one where the readiness gate matters. */
function stubRect(el: Element, r: { x: number; y: number; width: number; height: number }): void {
  el.getBoundingClientRect = () =>
    ({ ...r, top: r.y, left: r.x, right: r.x + r.width, bottom: r.y + r.height, toJSON: () => ({}) }) as DOMRect;
}

beforeEach(() => {
  document.body.innerHTML = "";
});

const NEW_COMMENTS = `
  <shreddit-comment thingid="t1_c1" author="alice" score="5"><div slot="comment">a</div>
    <shreddit-comment-action-row><button>Reply</button></shreddit-comment-action-row></shreddit-comment>
  <shreddit-comment thingid="t1_c2" author="bob" score="99"><div slot="comment">b</div>
    <shreddit-comment-action-row><button>Reply</button></shreddit-comment-action-row></shreddit-comment>`;

const OLD_COMPOSER = `
  <div class="commentarea">
    <div class="usertext-edit"><textarea name="text"></textarea></div>
    <div class="usertext-buttons"><button class="save">save</button></div>
  </div>`;

describe("locateComposerEntry", () => {
  it("new Reddit: returns the collapsed faceplate entry with needsExpand=true", () => {
    const root = mount(`<comment-composer-host><faceplate-textarea-input placeholder="Add a comment"></faceplate-textarea-input></comment-composer-host>`);
    const res = locateComposerEntry(root, "www.reddit.com");
    expect(res.ok).toBe(true);
    expect(res.observed).toMatchObject({ flavor: "new", needsExpand: true });
  });
  it("old Reddit: returns the visible textarea directly with needsExpand=false", () => {
    const root = mount(OLD_COMPOSER);
    const res = locateComposerEntry(root, "old.reddit.com");
    expect(res.ok).toBe(true);
    expect(res.observed).toMatchObject({ flavor: "old", needsExpand: false });
  });
  it("new Reddit: reports skipReason when no composer entry exists", () => {
    const root = mount(`<div>no composer here</div>`);
    const res = locateComposerEntry(root, "www.reddit.com");
    expect(res.ok).toBe(false);
    expect(res.skipReason).toBe("composer-entry-not-found");
  });
});

describe("locateCommentReplyButton", () => {
  it("prefers the comment whose id === commentId", () => {
    const root = mount(NEW_COMMENTS);
    const res = locateCommentReplyButton(root, "c2", "www.reddit.com");
    expect(res.ok).toBe(true);
    expect(res.observed).toMatchObject({ comment_id: "c2", author: "bob" });
  });
  it("falls back to the highest-in-DOM comment when no commentId is given", () => {
    const root = mount(NEW_COMMENTS);
    const res = locateCommentReplyButton(root, undefined, "www.reddit.com");
    expect(res.ok).toBe(true);
    expect(res.observed).toMatchObject({ comment_id: "c1" });
  });
  it("reports skipReason when there are no comments", () => {
    const root = mount(`<div>empty</div>`);
    const res = locateCommentReplyButton(root, "c2", "www.reddit.com");
    expect(res.ok).toBe(false);
    expect(res.skipReason).toBe("no-comments-found");
  });
  it("FIX 1: a PROVIDED commentId matching NO node → ok:false (never falls back to comment[0])", () => {
    const root = mount(NEW_COMMENTS); // has c1, c2 — but not the requested id
    const res = locateCommentReplyButton(root, "not-here", "www.reddit.com");
    expect(res.ok).toBe(false);
    expect(res.skipReason).toBe("target-comment-not-found");
  });
});

describe("locatedCommentMatches — background target-verification guard (FIX 1)", () => {
  it("true when the located id equals the requested comment id", () => {
    expect(locatedCommentMatches({ comment_id: "c2" }, "c2")).toBe(true);
  });
  it("false when the located id differs — a mismatch is REJECTED (never post to the wrong comment)", () => {
    expect(locatedCommentMatches({ comment_id: "c1" }, "c2")).toBe(false);
  });
  it("false (fail-closed) when the located id is missing/undefined", () => {
    expect(locatedCommentMatches({}, "c2")).toBe(false);
    expect(locatedCommentMatches(undefined, "c2")).toBe(false);
  });
  it("true when no specific comment was requested (post / permalink focus)", () => {
    expect(locatedCommentMatches({ comment_id: "c1" }, undefined)).toBe(true);
  });
});

describe("locateReplyBox readiness gate", () => {
  it("returns not-ready while the editable is 0×0 (collapsed composer)", () => {
    const root = mount(`<div contenteditable="true" name="body" role="textbox"></div>`);
    const res = locateReplyBox(root, "www.reddit.com"); // jsdom rect is 0×0
    expect(res.ok).toBe(false);
    expect(res.skipReason).toBe("reply-box-not-ready");
  });
  it("returns ok once the editable has a non-zero rect", () => {
    const root = mount(`<div contenteditable="true" name="body" role="textbox"></div>`);
    const box = root.querySelector('[contenteditable="true"]')!;
    stubRect(box, { x: 10, y: 20, width: 300, height: 80 });
    const res = locateReplyBox(root, "www.reddit.com");
    expect(res.ok).toBe(true);
    expect(res.rect).toEqual({ x: 10, y: 20, width: 300, height: 80 });
  });
  it("old Reddit: the visible textarea is ready when it has a rect", () => {
    const root = mount(OLD_COMPOSER);
    stubRect(root.querySelector("textarea[name='text']")!, { x: 0, y: 0, width: 500, height: 120 });
    const res = locateReplyBox(root, "old.reddit.com");
    expect(res.ok).toBe(true);
    expect(res.observed).toMatchObject({ flavor: "old" });
  });
});

describe("locateReplySubmit", () => {
  it("new Reddit: finds the slotted submit button + observed via/text/type/slot", () => {
    const root = mount(`<button type="submit" slot="submit-button">Comment</button>`);
    stubRect(root.querySelector("button")!, { x: 5, y: 5, width: 80, height: 32 });
    const res = locateReplySubmit(root, "www.reddit.com");
    expect(res.ok).toBe(true);
    // The observed descriptor rides into the not-cleared failure detail so a DB
    // row names the exact button that was clicked.
    expect(res.observed).toMatchObject({ text: "Comment", type: "submit", slot: "submit-button" });
  });
  it("old Reddit: finds button.save", () => {
    const root = mount(OLD_COMPOSER);
    stubRect(root.querySelector("button.save")!, { x: 5, y: 5, width: 60, height: 24 });
    const res = locateReplySubmit(root, "old.reddit.com");
    expect(res.ok).toBe(true);
    expect(res.observed).toMatchObject({ via: "old-save" });
  });
  it("reports skipReason when absent", () => {
    const root = mount(`<div>no submit</div>`);
    const res = locateReplySubmit(root, "www.reddit.com");
    expect(res.ok).toBe(false);
    expect(res.skipReason).toBe("reply-submit-not-found");
  });
  it("FIX 4: a disabled submit → ok:false (typed text hasn't registered)", () => {
    const root = mount(`<button type="submit" slot="submit-button" disabled>Comment</button>`);
    const res = locateReplySubmit(root, "www.reddit.com");
    expect(res.ok).toBe(false);
    expect(res.skipReason).toBe("reply-submit-disabled");
  });
  it("FIX 4: an aria-disabled submit → ok:false", () => {
    const root = mount(`<button type="submit" slot="submit-button" aria-disabled="true">Comment</button>`);
    expect(locateReplySubmit(root, "www.reddit.com").skipReason).toBe("reply-submit-disabled");
  });
  it("ports #442: a ZERO-RECT submit → ok:false (a trusted click would land at the viewport corner)", () => {
    const root = mount(`<button type="submit" slot="submit-button">Comment</button>`);
    // jsdom rects are all-zero by default — exactly the hidden/detached case.
    const res = locateReplySubmit(root, "www.reddit.com");
    expect(res.ok).toBe(false);
    expect(res.skipReason).toBe("submit-zero-rect");
  });
});

describe("readReplyBox — failure-path composer read (ports #442)", () => {
  it("no composer → present:false", () => {
    const res = readReplyBox(mount(`<div>nothing</div>`), "www.reddit.com");
    expect(res.observed).toMatchObject({ present: false, empty: true });
  });
  it("a populated composer → present:true, empty:false (the reply is stuck un-submittable)", () => {
    const root = mount(`<div contenteditable="true" name="body" role="textbox">my reply text</div>`);
    expect(readReplyBox(root, "www.reddit.com").observed).toMatchObject({ present: true, empty: false });
  });
  it("scopes to the target comment's composer", () => {
    const root = mount(`
      <comment-composer-host><div contenteditable="true" name="body" role="textbox">post text</div></comment-composer-host>
      <shreddit-comment thingid="t1_c1"><comment-composer-host>
        <div contenteditable="true" name="body" role="textbox"></div>
      </comment-composer-host></shreddit-comment>`);
    expect(readReplyBox(root, "www.reddit.com", "c1").observed).toMatchObject({ present: true, empty: true });
  });
});

// FIX 2: on new Reddit (the DEFAULT surface) a COMMENT reply must NOT type into the
// page-level "Add a comment" POST composer (first in document order, collapsed 0×0).
// The reply box/submit are scoped to the composer that mounts under the target
// shreddit-comment, and a non-zero box wins over the collapsed post box.
const NEW_SCOPED_COMPOSER = `
  <comment-composer-host>
    <div contenteditable="true" name="body" role="textbox" id="post-box"></div>
    <button type="submit" slot="submit-button" id="post-submit">Comment</button>
  </comment-composer-host>
  <shreddit-comment thingid="t1_c1" author="alice" score="5">
    <div slot="comment">a</div>
    <shreddit-comment-action-row><button>Reply</button></shreddit-comment-action-row>
    <comment-composer-host>
      <div contenteditable="true" name="body" role="textbox" id="comment-box"></div>
      <button type="submit" slot="submit-button" id="comment-submit">Comment</button>
    </comment-composer-host>
  </shreddit-comment>`;

describe("locateReplyBox — new-Reddit comment scoping (FIX 2)", () => {
  it("returns the COMMENT composer (non-zero) over the collapsed 0×0 post box", () => {
    const root = mount(NEW_SCOPED_COMPOSER);
    stubRect(root.querySelector("#comment-box")!, { x: 10, y: 400, width: 320, height: 90 });
    // post box stays collapsed (jsdom 0×0)
    const res = locateReplyBox(root, "www.reddit.com", "c1");
    expect(res.ok).toBe(true);
    expect(res.rect).toEqual({ x: 10, y: 400, width: 320, height: 90 });
  });
  it("scopes by comment even when the post composer is ALSO expanded (non-zero)", () => {
    const root = mount(NEW_SCOPED_COMPOSER);
    stubRect(root.querySelector("#post-box")!, { x: 0, y: 0, width: 300, height: 80 }); // post composer expanded too
    stubRect(root.querySelector("#comment-box")!, { x: 10, y: 400, width: 320, height: 90 });
    const res = locateReplyBox(root, "www.reddit.com", "c1");
    expect(res.ok).toBe(true);
    expect(res.rect).toEqual({ x: 10, y: 400, width: 320, height: 90 }); // the COMMENT box, not the post box
  });
  it("without a commentId (POST target) uses the page-level composer", () => {
    const root = mount(NEW_SCOPED_COMPOSER);
    stubRect(root.querySelector("#post-box")!, { x: 0, y: 0, width: 300, height: 80 });
    const res = locateReplyBox(root, "www.reddit.com");
    expect(res.ok).toBe(true);
    expect(res.rect).toEqual({ x: 0, y: 0, width: 300, height: 80 }); // the post box
  });
});

describe("verifyReplyCleared — post-submit confirmation (FIX 4)", () => {
  it("a still-present, non-empty editable → cleared:false (NOT posted)", () => {
    const root = mount(`<div contenteditable="true" name="body" role="textbox">my unsent reply text</div>`);
    expect(verifyReplyCleared(root, "www.reddit.com").cleared).toBe(false);
  });
  it("an emptied editable → cleared:true (posted)", () => {
    const root = mount(`<div contenteditable="true" name="body" role="textbox"></div>`);
    expect(verifyReplyCleared(root, "www.reddit.com").cleared).toBe(true);
  });
  it("an unmounted composer remains inconclusive", () => {
    const root = mount(`<div>no composer here</div>`);
    expect(verifyReplyCleared(root, "www.reddit.com")).toEqual({ cleared: false, present: false, empty: null });
  });
  it("scopes to the target comment's composer (post box empty, comment box still holds text)", () => {
    const root = mount(`
      <comment-composer-host><div contenteditable="true" name="body" role="textbox"></div></comment-composer-host>
      <shreddit-comment thingid="t1_c1"><comment-composer-host>
        <div contenteditable="true" name="body" role="textbox">still typing under the comment</div>
      </comment-composer-host></shreddit-comment>`);
    expect(verifyReplyCleared(root, "www.reddit.com", "c1").cleared).toBe(false);
  });
});

describe("locateAmbientComments", () => {
  it("locates a thread to open (read-only decoy)", () => {
    const root = mount(`<div class="thing link" data-url="u"><a class="comments" href="/r/x/comments/1/">42 comments</a></div>`);
    const res = locateAmbientComments(root, rng, "old.reddit.com");
    expect(res.ok).toBe(true);
  });
  it("reports skipReason when nothing is openable", () => {
    const res = locateAmbientComments(mount(`<div></div>`), rng, "old.reddit.com");
    expect(res.ok).toBe(false);
    expect(res.skipReason).toBe("no-thread-to-open");
  });
});

describe("locateUpvote (idle-upvote; UPVOTE-ONLY)", () => {
  it("new Reddit: locates a feed post's upvote button (open shadow root) + observed post_id/subreddit", () => {
    document.body.innerHTML = "";
    const post = document.createElement("shreddit-post");
    post.setAttribute("id", "t3_abc123");
    post.setAttribute("permalink", "/r/SaaS/comments/abc123/x/");
    post.attachShadow({ mode: "open" }).innerHTML =
      `<button data-action-bar-action="upvote" aria-pressed="false"></button>`;
    document.body.appendChild(post);
    const res = locateUpvote(document.body, rng, "www.reddit.com");
    expect(res.ok).toBe(true);
    expect(res.observed).toMatchObject({ flavor: "new", post_id: "abc123", subreddit: "SaaS" });
  });
  it("old Reddit: locates the un-modded up arrow with observed subreddit", () => {
    const root = mount(`<div class="thing link" data-permalink="/r/webdev/comments/1/x/"><div class="arrow up"></div></div>`);
    const res = locateUpvote(root, rng, "old.reddit.com");
    expect(res.ok).toBe(true);
    expect(res.observed).toMatchObject({ flavor: "old", subreddit: "webdev" });
  });
  it("ok:false when every post is already upvoted — diagnostics say withBtn>0 (ports #410)", () => {
    const root = mount(`<div class="thing link"><div class="arrow up upmod"></div></div>`);
    const res = locateUpvote(root, rng, "old.reddit.com");
    expect(res.ok).toBe(false);
    // posts=1 with an (upmod-pressed) button present ⇒ "all already upvoted", not drift.
    expect(res.skipReason).toBe("no-upvotable-post(posts=1,withBtn=1,btns=1,path=/,flavor=old)");
  });
  it("ok:false when no post is present — diagnostics say posts=0 (ports #410)", () => {
    const res = locateUpvote(mount(`<div>empty</div>`), rng, "www.reddit.com");
    expect(res.ok).toBe(false);
    expect(res.skipReason).toBe("no-upvotable-post(posts=0,withBtn=0,btns=0,path=/,flavor=new)");
  });
  it("diagnostics count shadow-root upvote buttons on new Reddit (already-pressed post)", () => {
    document.body.innerHTML = "";
    const post = document.createElement("shreddit-post");
    post.attachShadow({ mode: "open" }).innerHTML =
      `<button data-action-bar-action="upvote" aria-pressed="true"></button>`;
    document.body.appendChild(post);
    const res = locateUpvote(document.body, rng, "www.reddit.com");
    expect(res.ok).toBe(false);
    expect(res.skipReason).toBe("no-upvotable-post(posts=1,withBtn=1,btns=1,path=/,flavor=new)");
  });
  it("surfaces wordCount + hasMedia so the background can read-dwell before upvoting (read-before-like wiring)", () => {
    const root = mount(`<div class="thing link" data-permalink="/r/webdev/comments/1/x/">
      <div class="arrow up"></div>
      <div class="usertext-body"><div class="md">one two three four five six</div></div>
    </div>`);
    const res = locateUpvote(root, rng, "old.reddit.com");
    expect(res.ok).toBe(true);
    expect(res.observed).toMatchObject({ wordCount: 6, hasMedia: false });
  });
  it("reports hasMedia:true for a post with a thumbnail (dwell hint)", () => {
    const root = mount(`<div class="thing link" data-permalink="/r/pics/comments/2/x/" data-url="https://i.redd.it/x.jpg">
      <div class="arrow up"></div>
      <a class="thumbnail" href="https://i.redd.it/x.jpg"></a>
    </div>`);
    const res = locateUpvote(root, rng, "old.reddit.com");
    expect(res.ok).toBe(true);
    expect(res.observed).toMatchObject({ hasMedia: true });
  });
  it("read-before-upvote: the located payload drives a positive human dwell (decideStop → readingDwellMs | glanceMs)", () => {
    const root = mount(`<div class="thing link" data-permalink="/r/webdev/comments/3/x/">
      <div class="arrow up"></div>
      <div class="usertext-body"><div class="md">${"word ".repeat(120)}</div></div>
    </div>`);
    const loc = locateUpvote(root, makeRng(1), "old.reddit.com");
    const wc = loc.observed!.wordCount as number;
    const media = loc.observed!.hasMedia as boolean;
    expect(wc).toBe(120);
    // The exact calls doUpvote now makes before landing the click.
    const dwellRng = makeRng(7);
    const stop = decideStop(dwellRng, wc, { hasMedia: media });
    const dwell = stop ? readingDwellMs(dwellRng, wc, { hasMedia: media }, 240) : glanceMs(dwellRng);
    expect(dwell).toBeGreaterThan(0);
  });
});

describe("locateSave (idle post-save; DEFAULT-OFF; SAVE-ONLY)", () => {
  it("new Reddit: returns the overflow opener with observed.needsMenu=true + post_id/subreddit", () => {
    document.body.innerHTML = "";
    const post = document.createElement("shreddit-post");
    post.setAttribute("id", "t3_abc123");
    post.setAttribute("permalink", "/r/SaaS/comments/abc123/x/");
    post.attachShadow({ mode: "open" }).innerHTML =
      `<button data-action-bar-action="overflow" aria-label="more options">…</button>`;
    document.body.appendChild(post);
    const res = locateSave(document.body, rng, "www.reddit.com");
    expect(res.ok).toBe(true);
    expect(res.observed).toMatchObject({ flavor: "new", needsMenu: true, post_id: "abc123", subreddit: "SaaS" });
  });
  it("old Reddit: returns the direct save link with observed.needsMenu=false (one-click save)", () => {
    const root = mount(`<div class="thing link" data-permalink="/r/webdev/comments/1/x/"><form class="save-button"><a href="#">save</a></form></div>`);
    const res = locateSave(root, rng, "old.reddit.com");
    expect(res.ok).toBe(true);
    expect(res.observed).toMatchObject({ flavor: "old", needsMenu: false, subreddit: "webdev" });
  });
  it("ok:false with a self-diagnosing reason when nothing is saveable (caller falls back to upvote)", () => {
    const root = mount(`<div class="thing link saved"><form class="save-button"><a href="#">save</a></form></div>`);
    const res = locateSave(root, rng, "old.reddit.com");
    expect(res.ok).toBe(false);
    expect(res.skipReason).toContain("no-saveable-post");
  });
});

describe("locateSaveInMenu (open overflow menu, two-step new Reddit)", () => {
  it("locates the Save item without scrolling (menu stays open)", () => {
    const root = mount(`<div role="menu"><div role="menuitem">Share</div><div role="menuitem">Save</div></div>`);
    const res = locateSaveInMenu(root, "www.reddit.com");
    expect(res.ok).toBe(true);
    expect(res.rect).toBeTruthy();
  });
  it("ok:false when the menu isn't open / the Save item drifted (background Escape-dismisses + falls back)", () => {
    const res = locateSaveInMenu(mount(`<div>no menu</div>`), "www.reddit.com");
    expect(res.ok).toBe(false);
    expect(res.skipReason).toBe("save-item-not-found");
  });
  it("old Reddit has no menu step (one-click save)", () => {
    const res = locateSaveInMenu(mount(`<div class="thing link"></div>`), "old.reddit.com");
    expect(res.ok).toBe(false);
    expect(res.skipReason).toBe("save-menu-old-reddit");
  });
});

describe("detectChallenge (locator wrapper)", () => {
  it("passes through the selector's ChallengeResult", () => {
    const root = mount(`<div class="ratelimit">You're doing that too much. Try again in 5 minutes.</div>`);
    expect(detectChallenge(root)).toEqual({ challenge: true, kind: "throttle" });
  });
});

describe("locateDirtyReplyBox", () => {
