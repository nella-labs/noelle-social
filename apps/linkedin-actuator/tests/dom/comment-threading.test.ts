// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  commentIdOf,
  locateCommentByUrn,
  locateCommentReplyButton,
  locateReplyComposer,
  locateReplySubmit,
  replyComposerMention,
  locateLoadMoreComments,
  commentDeepLink,
} from "../../src/content/comment-threading.js";

import { initContent } from "../../src/content/index.js";
vi.mock("../../src/content/panel.js", () => ({ mountPanel: vi.fn() }));

const here = dirname(fileURLToPath(import.meta.url));
const page = () => readFileSync(join(here, "..", "fixtures", "post-comments-2026.html"), "utf8");
const mount = (html: string) => {
  document.body.innerHTML = html;
  return document.body;
};

// jsdom does not lay out, so every rect is zero — and the locators now REFUSE a
// zero rect (a synthesized 4x4 box at {0,0} would send a trusted click to the
// viewport corner). Stub it, exactly as tests/dom/locators.test.ts does.
beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
    x: 10, y: 20, width: 40, height: 20, top: 20, left: 10, right: 50, bottom: 40, toJSON: () => ({}),
  } as DOMRect);
});

// The real ids out of the capture.
const POST = "urn:li:ugcPost:7486054278927835136";
const OURS = "7486091099183251456"; // Alex's own comment
const THEIRS = "7487199472029192192"; // Malena replying to us — the notification
const OTHER = "7486071797881315328"; // an unrelated third-party comment

describe("commentIdOf accepts every shape the pipeline stores", () => {
  it("reads the flat urn the sweep writes as external_id", () => {
    expect(commentIdOf(`urn:li:comment:${THEIRS}`)).toBe(THEIRS);
  });

  it("reads the tuple urn the DOM renders", () => {
    expect(commentIdOf(`urn:li:comment:(${POST},${THEIRS})`)).toBe(THEIRS);
  });

  it("passes a bare id through", () => {
    expect(commentIdOf(THEIRS)).toBe(THEIRS);
  });

  it("returns null rather than guessing", () => {
    expect(commentIdOf("")).toBeNull();
    expect(commentIdOf(null)).toBeNull();
    expect(commentIdOf("urn:li:activity:123")).toBeNull();
  });
});

describe("locateCommentByUrn against the real capture", () => {
  it("finds the comment the notification points at", () => {
    const root = mount(page());
    const el = locateCommentByUrn(root, THEIRS);
    expect(el).not.toBeNull();
    expect(el!.getAttribute("id")).toContain(THEIRS);
    expect(el!.textContent).toContain("thank you so much!! I will");
  });

  it("finds a DIFFERENT comment for a different id — never the first one", () => {
    const root = mount(page());
    expect(locateCommentByUrn(root, OTHER)!.textContent).toContain("Congratulations, Malena!");
    expect(locateCommentByUrn(root, OURS)!.textContent).toContain("advanced econometrics");
  });

  it("does not prefix-match a longer id", () => {
    const root = mount(page());
    expect(locateCommentByUrn(root, THEIRS.slice(0, -1))).toBeNull();
    expect(locateCommentByUrn(root, `${THEIRS}0`)).toBeNull();
  });

  it("resolves correctly with a genuine suffix COLLIDER on the page", () => {
    // The absent-id test above cannot separate "correctly anchored" from "the
    // collider simply is not there". Here `456` and `123456` both exist, and
    // `123456` ends with `456` — the exact shape a substring match gets wrong.
    const root = mount(`
      <div>
        <div id="replaceableComment_urn:li:comment:(urn:li:ugcPost:1,123456)"><b>long</b></div>
        <div id="replaceableComment_urn:li:comment:(urn:li:ugcPost:1,456)"><b>short</b></div>
      </div>`);
    expect(locateCommentByUrn(root, "456")!.textContent).toBe("short");
    expect(locateCommentByUrn(root, "123456")!.textContent).toBe("long");
  });

  it("returns null for an id that is not on the page", () => {
    expect(locateCommentByUrn(mount(page()), "9999999999999999999")).toBeNull();
  });
});

describe("locateCommentReplyButton — the click that opens the right box", () => {
  it("finds the Reply button belonging to THAT comment", () => {
    const root = mount(page());
    const r = locateCommentReplyButton(root, THEIRS);
    expect(r.ok).toBe(true);
    expect(r.rect).toBeDefined();
  });

  it("returns a DIFFERENT button for a different comment — via the real API", () => {
    // Two different comment ids must not resolve to the same element: that
    // would answer the wrong person, publicly, under the operator's name.
    // Asserted through locateCommentReplyButton itself (an earlier version of
    // this test re-implemented the querySelector inline and so proved nothing
    // about the function).
    const root = mount(page());
    const a = locateCommentReplyButton(root, THEIRS);
    const b = locateCommentReplyButton(root, OTHER);
    expect(a.ok && b.ok).toBe(true);
    const el = (id: string) =>
      locateCommentByUrn(root, id)!.querySelector('button[aria-label="Reply"]');
    expect(el(THEIRS)).not.toBe(el(OTHER));
  });

  it("accepts the full urn as stored, not just the bare id", () => {
    expect(locateCommentReplyButton(mount(page()), `urn:li:comment:${THEIRS}`).ok).toBe(true);
  });

  it("refuses when the comment is gone (scrolled out / deleted)", () => {
    const r = locateCommentReplyButton(mount(page()), "9999999999999999999");
    expect(r.ok).toBe(false);
    expect(r.skipReason).toBe("comment-reply:comment-not-found");
  });
});

describe("the opened reply composer", () => {
  it("finds the editable that LinkedIn opened under the comment", () => {
    const r = locateReplyComposer(mount(page()), { afterCommentId: THEIRS });
    expect(r.ok).toBe(true);
  });

  it("reads back the mention chip naming the person being answered", () => {
    // An independent confirmation that the click landed on the right comment.
    expect(replyComposerMention(mount(page()), { afterCommentId: THEIRS })).toBe("Malena M.");
  });

  it("refuses when no composer is open", () => {
    const root = mount(page());
    for (const box of Array.from(root.querySelectorAll('[componentkey^="commentBox-"]'))) box.remove();
    for (const box of Array.from(root.querySelectorAll('[data-testid="ui-core-tiptap-text-editor-wrapper"]'))) box.remove();
    const r = locateReplyComposer(root, { afterCommentId: THEIRS });
    expect(r.ok).toBe(false);
    expect(r.skipReason).toBe("reply-composer:none-open");
  });
});

// THE SAFETY PROPERTY. A reply box submits with "Reply"; the post-level
// composer submits with "Comment". Requiring the word is what makes it
// structurally impossible to type a conversation answer and publish it as a
// second top-level comment — the failure that put five duplicate comments on
// Alex's own threads.
describe("locateReplySubmit refuses anything that is not a reply box", () => {
  it("finds the Reply submit of the opened composer", () => {
    const r = locateReplySubmit(mount(page()), { afterCommentId: THEIRS });
    expect(r.ok).toBe(true);
  });

  it("REFUSES when the submit says Comment — i.e. it is the post composer", () => {
    const root = mount(page());
    const label = Array.from(root.querySelectorAll("span")).find(
      (s) => s.textContent?.trim() === "Reply" && s.closest('[id*="commentButtonSection"]'),
    )!;
    label.textContent = "Comment";
    const r = locateReplySubmit(root, { afterCommentId: THEIRS });
    expect(r.ok).toBe(false);
    expect(r.skipReason).toBe("reply-submit:not-a-reply-box");
    expect((r.observed as { labels: string[] }).labels).toContain("Comment");
  });

  it("refuses rather than falling back to any nearby button", () => {
    const root = mount(page());
    // Scoped to MALENA's own section. The page also holds the post-level
    // section and Mateu's, and grabbing "the first one" is precisely the bug
    // this file guards against.
    // Her submit section is a SIBLING of the editor, not a child — which is
    // exactly why the locator walks upward from the editor to find it.
    const section = root.querySelector('[id^="Ki8K"][id*="commentButtonSection"]')!;
    section.innerHTML = '<button type="button"><span>Post</span></button>';
    const r = locateReplySubmit(root, { afterCommentId: THEIRS });
    expect(r.ok).toBe(false);
    expect(r.skipReason).toBe("reply-submit:not-a-reply-box");
  });
});

// End-to-end shape of the actuation, as the background will drive it.
describe("the whole threading path on the real capture", () => {
  it("comment → its Reply button → the composer → a Reply submit", () => {
    const root = mount(page());
    const target = `urn:li:comment:${THEIRS}`;

    const button = locateCommentReplyButton(root, target);
    expect(button.ok).toBe(true);

    // (the click happens via CDP; the fixture already shows the post-click DOM)
    const editor = locateReplyComposer(root, { afterCommentId: target });
    expect(editor.ok).toBe(true);
    expect(replyComposerMention(root, { afterCommentId: target })).toBe("Malena M.");

    const submit = locateReplySubmit(root, { afterCommentId: target });
    expect(submit.ok).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Everything below was added after an adversarial review proved the first cut
// could target the WRONG composer while reporting success. The fixture now
// carries THREE composers — the post-level one (submit "Comment"), Malena's
// open reply box, and Mateu's — so "pick the right one" is genuinely exercised
// rather than being true by there only ever being one.
// ─────────────────────────────────────────────────────────────────────────────

describe("a target that resolves to nothing must REFUSE, never fall back", () => {
  // The original fell through to "the first composer on the page". With a real
  // post-level composer present that is the operator's own "Add a comment"
  // box — so a conversation reply would have been typed into it. The comment
  // list is a virtualized LazyColumn, so an anchor really can vanish between
  // the Reply click and this read.
  it("refuses when the comment id is not on the page", () => {
    const root = mount(page());
    const r = locateReplyComposer(root, { afterCommentId: "9999999999999999999" });
    expect(r.ok).toBe(false);
    expect(r.skipReason).toBe("reply-composer:comment-not-found");
  });

  it("refuses an unparseable target rather than guessing", () => {
    const r = locateReplyComposer(mount(page()), { afterCommentId: "urn:li:activity:123" });
    expect(r.ok).toBe(false);
    expect(r.skipReason).toBe("reply-composer:bad-target-id");
  });

  it("the submit refuses too — the whole path is closed, not just one end", () => {
    const r = locateReplySubmit(mount(page()), { afterCommentId: "9999999999999999999" });
    expect(r.ok).toBe(false);
    expect(r.skipReason).toBe("reply-composer:comment-not-found");
  });

  it("never reports a mention for a target that does not exist", () => {
    expect(replyComposerMention(mount(page()), { afterCommentId: "9999999999999999999" })).toBeNull();
  });
});

describe("the composer must BELONG to the comment, not merely follow it", () => {
  // If the target's box never opened (missed click, render race, a box left
  // open by an earlier run) the NEXT comment's box is also "below" the anchor.
  // The "Reply" label check cannot catch this — every reply box says Reply.
  it("refuses when another comment sits between the anchor and the box", () => {
    const root = mount(page());
    // Malena's own composer is removed, so the next box below her is Mateu's —
    // with Mateu's comment in between.
    root.querySelector('[componentkey^="commentBox-Ki8K"]')!.closest(".ae29cd27")!.remove();
    const r = locateReplyComposer(root, { afterCommentId: THEIRS });
    expect(r.ok).toBe(false);
    expect(r.skipReason).toBe("reply-composer:not-this-comments-box");
  });

  it("picks each comment's OWN box when both are open", () => {
    const root = mount(page());
    expect(replyComposerMention(root, { afterCommentId: THEIRS })).toBe("Malena M.");
    expect(replyComposerMention(root, { afterCommentId: OTHER })).toBe("Mateu Rojas Comella");
  });

  it("never resolves to the POST-level composer, which sits above every comment", () => {
    const root = mount(page());
    // It is first in document order, so a naive boxes[0] would take it.
    expect(root.querySelector('[componentkey^="commentBox-POSTLEVEL"]')).not.toBeNull();
    expect(replyComposerMention(root, { afterCommentId: THEIRS })).toBe("Malena M.");
  });
});

describe("expectMention — independent proof of who we are answering", () => {
  it("accepts when the chip names the expected person", () => {
    const r = locateReplySubmit(mount(page()), { afterCommentId: THEIRS, expectMention: "Malena M." });
    expect(r.ok).toBe(true);
  });

  it("REFUSES when the box names somebody else", () => {
    const r = locateReplySubmit(mount(page()), { afterCommentId: THEIRS, expectMention: "Mateu Rojas Comella" });
    expect(r.ok).toBe(false);
    expect(r.skipReason).toBe("reply-submit:wrong-person");
  });
});

describe("reply composer ownership across comment containers", () => {
  const containers = [
    ["data-id", "urn:li:comment:"],
    ["id", "replaceableComment_urn:li:comment:"],
    ["componentkey", "CommentComponentReference_urn:li:comment:"],
  ] as const;
  const box = '<div class="comments-comment-box"><div contenteditable="true" role="textbox">Reply body</div><div id="commentButtonSection"><button>Reply</button></div></div>';
  it.each(containers)("rejects a following %s comment's editor", (attribute, prefix) => {
    const root = mount(`<article data-id="urn:li:comment:(ugcPost:123,111)"></article><article ${attribute}="${prefix}(ugcPost:123,222)">${box}</article>`);
    expect(locateReplyComposer(root, { afterCommentId: "111" }).ok).toBe(false);
    expect(locateReplySubmit(root, { afterCommentId: "111" }).ok).toBe(false);
  });
  it.each(containers)("rejects a nested foreign %s comment's editor", (attribute, prefix) => {
    const root = mount(`<article data-id="urn:li:comment:(ugcPost:123,111)"><article ${attribute}="${prefix}(ugcPost:123,222)">${box}</article></article>`);
    expect(locateReplyComposer(root, { afterCommentId: "111" }).ok).toBe(false);
    expect(locateReplySubmit(root, { afterCommentId: "111" }).ok).toBe(false);
  });
  it.each(containers)("accepts nested %s wrappers for the same target", (attribute, prefix) => {
    const root = mount(`<article data-id="urn:li:comment:(ugcPost:123,111)"><div ${attribute}="${prefix}(ugcPost:123,111)">${box}</div></article>`);
    expect(locateReplyComposer(root, { afterCommentId: "111" }).ok).toBe(true);
    expect(locateReplySubmit(root, { afterCommentId: "111" }).ok).toBe(true);
  });
});

describe("zero-rect and disabled guards, matching every sibling locator", () => {
  it("refuses a zero-sized target instead of clicking the viewport corner", () => {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      x: 0, y: 0, width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0, toJSON: () => ({}),
    } as DOMRect);
    const r = locateCommentReplyButton(mount(page()), THEIRS);
    expect(r.ok).toBe(false);
    expect(r.skipReason).toBe("comment-reply:zero-rect");
  });

  it("refuses a disabled submit — clicking it is a silent no-op", () => {
    const root = mount(page());
    const btn = Array.from(root.querySelectorAll("button")).find(
      (b) => b.textContent?.trim() === "Reply" && b.closest('[id*="commentButtonSection"]'),
    )!;
    btn.setAttribute("aria-disabled", "true");
    const r = locateReplySubmit(root, { afterCommentId: THEIRS });
    expect(r.ok).toBe(false);
  });
});

describe("the componentkey fallback only accepts real comment containers", () => {
  it("does not scope to a replies-thread wrapper keyed by the same urn", () => {
    // Such a wrapper holds OTHER people's comments, so scoping to it would
    // return the wrong person's Reply button while reporting success.
    const root = mount(`
      <div>
        <div componentkey="replaceableComment_urn:li:comment:(urn:li:ugcPost:1,444)">
          <button aria-label="Reply" id="right"></button>
        </div>
        <div componentkey="repliesThread_urn:li:comment:(urn:li:ugcPost:1,444)">
          <div componentkey="replaceableComment_urn:li:comment:(urn:li:ugcPost:1,555)">
            <button aria-label="Reply" id="wrong"></button>
          </div>
        </div>
      </div>`);
    const el = locateCommentByUrn(root, "444");
    expect(el).not.toBeNull();
    expect(el!.querySelector("button")!.id).toBe("right");
  });
});

// LinkedIn can hide the target comment behind a load-more control. Expand it
// before treating an absent comment as a locator failure.
describe("reaching the comment before looking for it", () => {
  it("finds the expander on the real captured page", () => {
    const r = locateLoadMoreComments(mount(page()));
    expect(r.ok).toBe(true);
  });

  it("matches the phrasings LinkedIn uses", () => {
    for (const label of ["See 33 more comments", "Load more comments", "Show previous comments", "See more comments"]) {
      const root = mount(`<div><div role="button"><p>${label}</p></div></div>`);
      expect(locateLoadMoreComments(root).ok, label).toBe(true);
    }
  });

  it("does not mistake an ordinary button for the expander", () => {
    const root = mount(`<div><button>Comment</button><button>Reply</button><button>See profile</button></div>`);
    expect(locateLoadMoreComments(root).ok).toBe(false);
  });

  it("reports not-found rather than guessing when the thread is fully expanded", () => {
    const root = mount(page());
    root.querySelector('[id*="replaceableLoadMoreComments"]')!.remove();
    const r = locateLoadMoreComments(root);
    expect(r.ok).toBe(false);
    expect(r.skipReason).toBe("load-more-comments:not-found");
  });
});

describe("commentDeepLink — arrive where a human would", () => {
  const POSTURL = "https://www.linkedin.com/feed/update/urn:li:ugcPost:7486054278927835136/";

  it("rebuilds the TUPLE urn LinkedIn needs from what the sweep stored", () => {
    // The sweep stores the flat `urn:li:comment:<id>`; the deep link needs
    // `urn:li:comment:(<post>,<id>)`.
    const out = commentDeepLink(POSTURL, "urn:li:ugcPost:7486054278927835136", `urn:li:comment:${THEIRS}`);
    expect(out).toContain("commentUrn=");
    expect(decodeURIComponent(out)).toContain(
      `urn:li:comment:(urn:li:ugcPost:7486054278927835136,${THEIRS})`,
    );
  });

  it("returns the url UNCHANGED when it cannot build one — never a reason to skip", () => {
    expect(commentDeepLink(POSTURL, null, `urn:li:comment:${THEIRS}`)).toBe(POSTURL);
    expect(commentDeepLink(POSTURL, "urn:li:ugcPost:1", null)).toBe(POSTURL);
    expect(commentDeepLink(POSTURL, "urn:li:ugcPost:1", "not-a-urn")).toBe(POSTURL);
  });

  it("appends correctly to a url that already has a query", () => {
    const out = commentDeepLink(`${POSTURL}?foo=1`, "urn:li:ugcPost:1", `urn:li:comment:${THEIRS}`);
    expect(out).toContain("?foo=1&commentUrn=");
  });
});

// Post permalinks can serve legacy Ember markup. The locator must support
// its comment identifiers as well as the current page shape.
describe("the legacy ember post page (what the actuator actually meets)", () => {
  const legacy = () =>
    readFileSync(join(here, "..", "fixtures", "post-comments-legacy-ember.html"), "utf8");

  it("finds a comment by its data-id, where the post half has NO urn:li: prefix", () => {
    // data-id="urn:li:comment:(ugcPost:748…,7487199472029192192)" — matching on
    // the ",<id>)" suffix is what makes the two generations interchangeable.
    const el = locateCommentByUrn(mount(legacy()), THEIRS);
    expect(el).not.toBeNull();
    expect(el!.textContent).toContain("thank you so much!! I will");
  });

  it("returns the REPLY, not the parent comment it is nested inside", () => {
    // Here replies live INSIDE the parent's <article>, so a naive match returns
    // the parent — and we would answer the wrong person.
    const root = mount(legacy());
    const theirs = locateCommentByUrn(root, THEIRS)!;
    const ours = locateCommentByUrn(root, OURS)!;
    expect(theirs).not.toBe(ours);
    expect(ours.contains(theirs)).toBe(true); // nested, as LinkedIn renders it
    expect(theirs.getAttribute("data-id")).toContain(THEIRS);
  });

  it("finds THAT comment's own Reply button, not a nested one", () => {
    // Through the REAL API, and with per-element rects so the two calls are
    // actually distinguishable — a single shared stub made every button return
    // identical coordinates, which hid whether the nesting logic worked at all.
    const root = mount(legacy());
    const label = (el: Element) => el.getAttribute("aria-label") ?? "";
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
      this: HTMLElement,
    ) {
      // Alex's button at y=100, Malena's at y=200 — so a wrong pick is visible.
      const y = label(this).includes("Malena") ? 200 : label(this).includes("Alex") ? 100 : 50;
      return { x: 10, y, width: 40, height: 20, top: y, left: 10, right: 50, bottom: y + 20, toJSON: () => ({}) } as DOMRect;
    });

    const forOurs = locateCommentReplyButton(root, OURS);
    const forTheirs = locateCommentReplyButton(root, THEIRS);
    expect(forOurs.ok && forTheirs.ok).toBe(true);
    // The parent's article CONTAINS the child's button, so these MUST differ.
    expect(forOurs.y).toBe(110); // centre of Alex's own button
    expect(forTheirs.y).toBe(210); // centre of Malena's
    expect(forOurs.y).not.toBe(forTheirs.y);
  });

  it("recognises the legacy expander (aria-label, not text)", () => {
    expect(locateLoadMoreComments(mount(legacy())).ok).toBe(true);
  });

  it("finds the legacy Quill composer", () => {
    const root = mount(legacy());
    // The post-level box is the only composer open here; the reply box appears
    // after clicking. What matters is that the editor is addressable at all.
    expect(root.querySelector(".ql-editor[contenteditable='true']")).not.toBeNull();
  });

  it("still refuses an id that is not on the page", () => {
    const r = locateCommentReplyButton(mount(legacy()), "9999999999999999999");
    expect(r.ok).toBe(false);
    expect(r.skipReason).toBe("comment-reply:comment-not-found");
  });
});

describe("registered threaded locator ownership", () => {
  type Reply = {
    ok: boolean;
    skipReason?: string;
    rect?: { x: number };
    observed?: unknown;
    mention?: string | null;
  };
  let handler: (message: unknown, sender: unknown, reply: (value: Reply) => void) => boolean;
  function command(cmd: string, extra: Record<string, unknown> = {}) {
    let result!: Reply;
    expect(
      handler({ cmd, commentUrn: "111", ...extra }, {}, (value) => {
        result = value;
      }),
    ).toBe(true);
    return result;
  }
  const anchor = (inner = "") =>
    `<article data-id="urn:li:comment:(ugcPost:123,111)"><button aria-label="Reply">Reply</button>${inner}</article>`;
  const box = (keyed = false, mention = "Ann Smith") =>
    `<div ${keyed ? 'componentkey="commentBox-target"' : 'class="comments-comment-box"'}><div contenteditable="true" role="textbox" data-x="10"><span data-type="mention">${mention}</span> approved body</div><section id="commentButtonSection-target"><button data-x="20">Reply</button></section></div>`;
  const foreign = () =>
    `<article data-id="urn:li:comment:(ugcPost:123,222)"><div componentkey="commentBox-foreign"><div contenteditable="true" role="textbox" data-x="200">other</div></div></article>`;
  beforeEach(() => {
    vi.stubGlobal("chrome", {
      runtime: {
        onMessage: {
          addListener: (fn: typeof handler) => {
            handler = fn;
          },
        },
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(() => {
        throw new Error("network forbidden");
      }),
    );
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
      this: HTMLElement,
    ) {
      const x = Number(this.getAttribute("data-x") ?? 1);
      return {
        x,
        y: 20,
        width: 40,
        height: 20,
        top: 20,
        left: x,
        right: x + 40,
        bottom: 40,
        toJSON: () => ({}),
      } as DOMRect;
    });
    initContent();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    document.body.innerHTML = "";
  });

  it.each([false, true])("accepts a sole %s keyed target composer", (keyed) => {
    document.body.innerHTML = anchor(box(keyed));
    expect(command("locateReplyComposer").ok).toBe(true);
    expect(command("locateReplySubmit", { expectMention: "Ann Smith" }).ok).toBe(true);
  });
  it.each(["nested", "adjacent"])(
    "chooses the existing %s target before a later foreign higher selector tier",
    (layout) => {
      document.body.innerHTML =
        (layout === "nested" ? anchor(box()) : anchor() + box()) + foreign();
      expect(command("locateReplyComposer")).toMatchObject({ ok: true, rect: { x: 10 } });
      expect(command("locateReplySubmit", { expectMention: "Ann Smith" })).toMatchObject({
        ok: true,
        rect: { x: 20 },
      });
      expect(command("readReplyComposer")).toMatchObject({
        ok: true,
        observed: { text: "approved body" },
      });
    },
  );
  it("refuses a foreign following composer when the target has none", () => {
    document.body.innerHTML = anchor() + foreign();
    expect(command("locateReplyComposer").ok).toBe(false);
  });
  it("refuses a different first name sharing the expected prefix", () => {
    document.body.innerHTML = anchor(box(true, "Anna Jones"));
    expect(command("locateReplySubmit", { expectMention: "Ann Smith" })).toMatchObject({
      ok: false,
      skipReason: "reply-submit:wrong-person",
    });
  });
  it("accepts the exact first name when the chip omits surname", () => {
    document.body.innerHTML = anchor(box(true, "Ann"));
    expect(command("locateReplySubmit", { expectMention: "Ann Smith" }).ok).toBe(true);
  });
  it("accepts matching first name with case and whitespace differences", () => {
    document.body.innerHTML = anchor(box(true, "  ANN   Smith  "));
    expect(command("locateReplySubmit", { expectMention: "ann smith" }).ok).toBe(true);
  });
  it("refuses an absent expected mention", () => {
    document.body.innerHTML = anchor(box(true, ""));
    expect(command("locateReplySubmit", { expectMention: "Ann Smith" }).ok).toBe(false);
  });

  it("prefers the explicitly target-owned box after a nested foreign comment composer", () => {
    document.body.innerHTML = anchor(foreign() + box());
    expect(command("locateReplyComposer")).toMatchObject({ ok: true, rect: { x: 10 } });
  });
  it("refuses a nested foreign composer when the target has no own box", () => {
    document.body.innerHTML = anchor(foreign());
    expect(command("locateReplyComposer").ok).toBe(false);
  });
  it("preserves a keyed target-owned box before a nested foreign comment", () => {
    document.body.innerHTML = anchor(box(true) + foreign());
    expect(command("locateReplyComposer")).toMatchObject({ ok: true, rect: { x: 10 } });
  });

  it("reads a mention-only target as measured empty body", () => {
    document.body.innerHTML = anchor(box(true));
    document.querySelector('[data-x="10"]')!.innerHTML =
      '<span data-type="mention">Ann Smith</span>\u200B\uFEFF';
    expect(command("readReplyComposer")).toMatchObject({
      ok: true,
      observed: { present: true, empty: true, text: "" },
    });
  });
  it("reads only the target body while another post editor is dirty", () => {
    document.body.innerHTML = box(true, "Other") + anchor(box(true));
    expect(command("readReplyComposer")).toMatchObject({
      ok: true,
      observed: { present: true, empty: false, text: "approved body" },
    });
  });
  it("accepts readable absence only under a still-mounted named anchor", () => {
    document.body.innerHTML = anchor();
    expect(command("readReplyComposer")).toMatchObject({
      ok: true,
      observed: { present: false, empty: true, text: "" },
    });
  });
  it("keeps a missing named anchor unknown", () => {
    document.body.innerHTML = box(true);
    expect(command("readReplyComposer")).toMatchObject({
      ok: false,
      skipReason: "reply-composer:comment-not-found",
    });
  });
  it("keeps a foreign-only following composer unknown", () => {
    document.body.innerHTML = anchor() + foreign();
    expect(command("readReplyComposer")).toMatchObject({
      ok: false,
      skipReason: "reply-composer:not-this-comments-box",
    });
  });
  it("keeps a nested foreign-only composer unknown", () => {
    document.body.innerHTML = anchor(foreign());
    expect(command("readReplyComposer")).toMatchObject({
      ok: false,
      skipReason: "reply-composer:not-this-comments-box",
    });
  });
  it("keeps a mounted box without its editor unknown", () => {
    document.body.innerHTML = anchor('<div componentkey="commentBox-target"></div>');
    expect(command("readReplyComposer")).toMatchObject({
      ok: false,
      skipReason: "reply-composer:no-editor",
    });
  });
});
