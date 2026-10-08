import { describe, expect, it } from "vitest";
import { hookFromBody, joinHook, stripLeadingHook } from "./hook-body";

describe("hook-body", () => {
  it("stripLeadingHook removes the leading hook line (and the blank line after it)", () => {
    const body = "The hook that stops the scroll\n\nThe real body, concrete and specific.";
    expect(stripLeadingHook(body, "The hook that stops the scroll")).toBe("The real body, concrete and specific.");
  });

  it("stripLeadingHook returns the body unchanged when it doesn't start with the hook", () => {
    expect(stripLeadingHook("something else entirely", "a hook")).toBe("something else entirely");
    expect(stripLeadingHook("body", null)).toBe("body");
    expect(stripLeadingHook("body", "   ")).toBe("body");
  });

  it("joinHook recombines hook + content into the full body", () => {
    expect(joinHook("Hook line", "Body line")).toBe("Hook line\n\nBody line");
    expect(joinHook("Hook only", "")).toBe("Hook only");
    expect(joinHook("Hook only", "   ")).toBe("Hook only");
    expect(joinHook("", "just content")).toBe("just content");
  });

  it("stripLeadingHook ∘ joinHook round-trips (LinkedIn/Reddit editor path)", () => {
    for (const body of [
      "One line only",
      "Hook line\n\nParagraph two\n\nParagraph three",
      "Hook\n\nBody with a trailing space ",
    ]) {
      const hook = hookFromBody(body);
      expect(joinHook(hook, stripLeadingHook(body, hook))).toBe(body);
    }
  });

  describe("X editor: whole ≤280 post is one atomic field", () => {
    const xPost =
      '"we raised $8.5M" tells me almost nothing, and the crowd cheering the number is watching the wrong thing.';

    it("the single-line post IS its own hook", () => {
      // In the X editor, fullBody = post and effectiveHook = hookFromBody(post).
      expect(hookFromBody(xPost)).toBe(xPost);
    });

    it("an unedited X draft round-trips to the same stored hook — no spurious rewrite", () => {
      // The drafter stored draft_hook = hookFromBody(body) at creation; opening the
      // draft and re-deriving must yield the identical string so save sends no hook.
      const storedHook = hookFromBody(xPost);
      expect(hookFromBody(xPost)).toBe(storedHook);
    });

    it("trims surrounding whitespace like the server's firstLineHook", () => {
      expect(hookFromBody("  padded post  ")).toBe("padded post");
    });

    it("skips a leading blank line to the first non-empty line", () => {
      expect(hookFromBody("\n\nreal opening line\nmore")).toBe("real opening line");
    });

    it("caps an overlong single line at 300 chars (matches firstLineHook)", () => {
      const long = "x".repeat(500);
      expect(hookFromBody(long)).toHaveLength(300);
    });

    it("empty body yields an empty hook", () => {
      expect(hookFromBody("")).toBe("");
      expect(hookFromBody("\n \n")).toBe("");
    });
  });
});
