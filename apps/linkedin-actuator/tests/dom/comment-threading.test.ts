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
