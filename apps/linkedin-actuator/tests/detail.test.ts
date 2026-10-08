import { describe, it, expect } from "vitest";
import { sanitizeDetailValue, notClearedDetail, submitNotFoundDetail } from "../src/background/detail.js";

describe("skip-detail formatting (comment-failed:<detail> diagnostics)", () => {
  it("sanitizeDetailValue keeps only [A-Za-z0-9 _-] and collapses whitespace", () => {
    // Scraped aria-labels carry quotes/parens/newlines that would corrupt the
    // reason grammar in linkedin_activity.
    expect(sanitizeDetailValue("Comment on Jane's post\n (10)")).toBe("Comment on Janes post 10");
    expect(sanitizeDetailValue("  composer:2  ")).toBe("composer2");
    expect(sanitizeDetailValue(undefined)).toBe("");
  });

  it("notClearedDetail names the clicked button: via + btn (aria over text) + type", () => {
    expect(notClearedDetail({ via: "composer:2", aria: "", text: "Comment", type: "submit" }))
      .toBe("not-cleared(via=composer2,btn=Comment,type=submit)");
    // aria wins when present (the more stable accessible name).
    expect(notClearedDetail({ via: "bem", aria: "Post comment", text: "Post", type: "button" }))
      .toBe("not-cleared(via=bem,btn=Post comment,type=button)");
  });

  it("notClearedDetail survives a missing descriptor (older content script still loaded)", () => {
    expect(notClearedDetail(undefined)).toBe("not-cleared(via=,btn=,type=)");
  });

  it("the whole detail is truncated to 120 chars", () => {
    const detail = notClearedDetail({ via: "global-primary", aria: "x".repeat(300), text: "", type: "button" });
    expect(detail.length).toBeLessThanOrEqual(120);
    expect(detail.startsWith("not-cleared(via=global-primary,btn=xxx")).toBe(true);
  });

  it("submitNotFoundDetail reports the composer state read after the poll", () => {
    expect(submitNotFoundDetail({ present: true, empty: false })).toBe("submit-not-found(b=itx3,box=present,empty=false)");
    expect(submitNotFoundDetail({ present: false, empty: true })).toBe("submit-not-found(b=itx3,box=absent,empty=true)");
    // A failed read (tab navigated away, content script gone) reads as absent.
    expect(submitNotFoundDetail(undefined)).toBe("submit-not-found(b=itx3,box=absent,empty=false)");
  });

  it("submitNotFoundDetail folds in the search diagnostic when present", () => {
    expect(submitNotFoundDetail({ present: true, empty: false }, { wf: 1, en: 0, vis: 0, all: 2, top: "Comment_dis" }))
      .toBe("submit-not-found(b=itx3,box=present,empty=false,wf=1,en=0,vis=0,all=2,top=Comment_dis)");
    // Missing/older-content-script diagnostic → base string, no trailing fields.
    expect(submitNotFoundDetail({ present: true, empty: false }, null))
      .toBe("submit-not-found(b=itx3,box=present,empty=false)");
    // Non-numeric counts degrade to '?', sanitized top survives.
    const d = submitNotFoundDetail({ present: true, empty: false }, { wf: "x", top: "a(b)c_pre" });
    expect(d).toContain("wf=?");
    expect(d).toContain("top=abc_pre");
  });

  it("submitNotFoundDetail appends the region dump (space-separated, sanitized)", () => {
    const d = submitNotFoundDetail(
      { present: true, empty: false },
      { wf: 0, en: 0, vis: 0, all: 4, top: "Comment_pre", region: "Comment_pb_001_gt Reply_fi_001_gn Post_fs_001_gn" },
    );
    expect(d).toContain(",reg=Comment_pb_001_gt Reply_fi_001_gn Post_fs_001_gn");
    // Longer diagnostic cap than the terse not-cleared line, still bounded.
    expect(d.length).toBeLessThanOrEqual(480);
    // No region → no reg= suffix.
    expect(submitNotFoundDetail({ present: true, empty: false }, { wf: 0 })).not.toContain("reg=");
  });
});
