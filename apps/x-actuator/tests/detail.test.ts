import { describe, it, expect } from "vitest";
import { sanitizeDetailValue, notClearedDetail, submitNotFoundDetail } from "../src/background/detail.js";

describe("skip-detail formatting (reply-failed:<detail> diagnostics)", () => {
  it("sanitizeDetailValue keeps only [A-Za-z0-9 _-] and collapses whitespace", () => {
    // Scraped aria-labels carry quotes/parens/newlines that would corrupt the
    // reason grammar in x_activity.
    expect(sanitizeDetailValue("12 Replies. Reply\n (inline)")).toBe("12 Replies Reply inline");
    expect(sanitizeDetailValue("  composer:2  ")).toBe("composer2");
    expect(sanitizeDetailValue(undefined)).toBe("");
  });

  it("notClearedDetail names the clicked button: via + btn (aria over text) + type", () => {
    expect(notClearedDetail({ via: "testid:tweetButtonInline", aria: "", text: "Reply", type: "button" }))
      .toBe("not-cleared(via=testidtweetButtonInline,btn=Reply,type=button)");
    // aria wins when present (the more stable accessible name).
    expect(notClearedDetail({ via: "composer:2", aria: "Post text", text: "Post", type: "submit" }))
      .toBe("not-cleared(via=composer2,btn=Post text,type=submit)");
  });

  it("notClearedDetail survives a missing descriptor (older content script still loaded)", () => {
    expect(notClearedDetail(undefined)).toBe("not-cleared(via=,btn=,type=)");
  });

  it("the whole not-cleared detail is truncated to 120 chars", () => {
    const detail = notClearedDetail({ via: "composer:3", aria: "x".repeat(300), text: "", type: "button" });
    expect(detail.length).toBeLessThanOrEqual(120);
    expect(detail.startsWith("not-cleared(via=composer3,btn=xxx")).toBe(true);
  });

  it("submitNotFoundDetail reports the composer state read after the poll + the build stamp", () => {
    expect(submitNotFoundDetail({ present: true, empty: false })).toBe("submit-not-found(b=xtx1,box=present,empty=false)");
    expect(submitNotFoundDetail({ present: false, empty: true })).toBe("submit-not-found(b=xtx1,box=absent,empty=true)");
    // A failed read (tab navigated away, content script gone) reads as absent.
    expect(submitNotFoundDetail(undefined)).toBe("submit-not-found(b=xtx1,box=absent,empty=false)");
  });

  it("submitNotFoundDetail folds in the search diagnostic when present", () => {
    expect(submitNotFoundDetail({ present: true, empty: false }, { wf: 1, en: 0, vis: 0, all: 2, top: "Reply_dis" }))
      .toBe("submit-not-found(b=xtx1,box=present,empty=false,wf=1,en=0,vis=0,all=2,top=Reply_dis)");
  });

  it("folds in the dom descriptor and region dump, dom before reg", () => {
    const d = submitNotFoundDetail(
      { present: true, empty: false },
      { wf: 0, en: 0, vis: 0, all: 1, top: "Reply_tog", dom: "bx_div pm_1 len_24", region: "Reply_pb_001_gt" },
    );
    expect(d).toContain(",dom=bx_div pm_1 len_24");
    expect(d).toContain(",reg=Reply_pb_001_gt");
    expect(d.indexOf(",dom=")).toBeLessThan(d.indexOf(",reg="));
  });

  it("missing diagnostic fields format as ? (older content script)", () => {
    expect(submitNotFoundDetail({ present: true, empty: true }, { top: "none" }))
      .toBe("submit-not-found(b=xtx1,box=present,empty=true,wf=?,en=?,vis=?,all=?,top=none)");
  });

  it("the diagnostic detail is capped at 600 chars", () => {
    const d = submitNotFoundDetail(
      { present: true, empty: false },
      { wf: 0, en: 0, vis: 0, all: 9, top: "t", dom: "d".repeat(400), region: "r".repeat(400) },
    );
    expect(d.length).toBeLessThanOrEqual(600);
  });
});
