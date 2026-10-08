import { describe, it, expect } from "vitest";
import { sanitizeDetailValue, notClearedDetail, submitNotFoundDetail } from "../src/background/detail.js";

describe("skip-detail formatting (reply-failed:<detail> diagnostics)", () => {
  it("sanitizeDetailValue keeps only [A-Za-z0-9 _-] and collapses whitespace", () => {
    // Scraped aria-labels carry quotes/parens/newlines that would corrupt the
    // reason grammar in reddit_activity.
    expect(sanitizeDetailValue("Reply to u/jane's comment\n (10)")).toBe("Reply to ujanes comment 10");
    expect(sanitizeDetailValue("  composer:2  ")).toBe("composer2");
    expect(sanitizeDetailValue(undefined)).toBe("");
  });

  it("notClearedDetail names the clicked button: via + btn + type (type over slot)", () => {
    expect(notClearedDetail({ via: "composer:1", text: "Comment", type: "submit", slot: "submit-button" }))
      .toBe("not-cleared(via=composer1,btn=Comment,type=submit)");
    // slot fills in when type is empty (the styling hook the button actually had).
    expect(notClearedDetail({ via: "global-slotted", text: "Comment", type: "", slot: "submit-button" }))
      .toBe("not-cleared(via=global-slotted,btn=Comment,type=submit-button)");
  });

  it("notClearedDetail survives a missing descriptor (older content script still loaded)", () => {
    expect(notClearedDetail(undefined)).toBe("not-cleared(via=,btn=,type=)");
  });

  it("the whole detail is truncated to 120 chars", () => {
    const detail = notClearedDetail({ via: "global-word", text: "x".repeat(300), type: "button" });
    expect(detail.length).toBeLessThanOrEqual(120);
    expect(detail.startsWith("not-cleared(via=global-word,btn=xxx")).toBe(true);
  });

  it("submitNotFoundDetail reports the build stamp + composer state read after the miss", () => {
    expect(submitNotFoundDetail({ present: true, empty: false })).toBe("submit-not-found(b=rsub2,box=present,empty=false)");
    // A failed read (tab navigated away, content script gone) reads as absent.
    expect(submitNotFoundDetail(undefined)).toBe("submit-not-found(b=rsub2,box=absent,empty=false)");
  });

  it("submitNotFoundDetail folds in the locator's last skipReason", () => {
    expect(submitNotFoundDetail({ present: true, empty: false }, "reply-submit-disabled"))
      .toBe("submit-not-found(b=rsub2,box=present,empty=false,last=reply-submit-disabled)");
    expect(submitNotFoundDetail({ present: false, empty: true }, "submit-zero-rect"))
      .toBe("submit-not-found(b=rsub2,box=absent,empty=true,last=submit-zero-rect)");
  });

  it("submitNotFoundDetail folds in the search diagnostic when present", () => {
    expect(
      submitNotFoundDetail(
        { present: true, empty: false },
        "reply-submit-disabled",
        { wf: 1, en: 0, vis: 0, slots: 1, scoped: 0, top: "Comment_dis", path: "/r/SaaS/comments/abc/x/" },
      ),
    ).toBe(
      "submit-not-found(b=rsub2,box=present,empty=false,last=reply-submit-disabled," +
        "wf=1,en=0,vis=0,slots=1,scoped=0,top=Comment_dis,path=-r-SaaS-comments-abc-x-)",
    );
    // Missing/older-content-script diagnostic → base string, no trailing fields.
    expect(submitNotFoundDetail({ present: true, empty: false }, undefined, null))
      .toBe("submit-not-found(b=rsub2,box=present,empty=false)");
    // Non-numeric counts degrade to '?', sanitized top survives.
    const d = submitNotFoundDetail({ present: true, empty: false }, undefined, { wf: "x", top: "a(b)c_pre" });
    expect(d).toContain("wf=?");
    expect(d).toContain("top=abc_pre");
    // Larger diagnostic cap than the terse not-cleared line, still bounded.
    expect(d.length).toBeLessThanOrEqual(600);
  });

  it("submitNotFoundDetail appends the region dump LAST (space-separated, sanitized)", () => {
    const d = submitNotFoundDetail(
      { present: true, empty: false },
      "reply-submit-disabled",
      { wf: 0, en: 0, vis: 0, slots: 1, scoped: 0, top: "Comment_pre", path: "/r/x/comments/y/z/",
        region: "Comment_pt_001_gn Reply_fs_001_go" },
    );
    expect(d).toContain(",reg=Comment_pt_001_gn Reply_fs_001_go");
    // reg= is the LAST field — the expendable dump gets truncated first, never
    // the counts/path before it.
    expect(d.indexOf(",reg=")).toBeGreaterThan(d.indexOf(",path="));
    expect(d.endsWith(")")).toBe(true);
    // A region carrying grammar-corrupting chars is sanitized to [A-Za-z0-9 _-].
    const dirty = submitNotFoundDetail({ present: true, empty: false }, undefined, { region: "Send(chat)_fs_000_gc" });
    expect(dirty).toContain(",reg=Sendchat_fs_000_gc");
    // No region → no reg= suffix.
    expect(submitNotFoundDetail({ present: true, empty: false }, undefined, { wf: 0 })).not.toContain("reg=");
  });
});
