import { describe, it, expect } from "vitest";
import { parseMessageSegments } from "./chat-markdown";

describe("parseMessageSegments", () => {
  it("returns a single text segment when there are no links", () => {
    expect(parseMessageSegments("just words")).toEqual([{ type: "text", value: "just words" }]);
  });

  it("parses a markdown link with surrounding text", () => {
    expect(
      parseMessageSegments("Try [reply to @simonw](https://x.com/intent/tweet?in_reply_to=1) now"),
    ).toEqual([
      { type: "text", value: "Try " },
      { type: "link", label: "reply to @simonw", href: "https://x.com/intent/tweet?in_reply_to=1" },
      { type: "text", value: " now" },
    ]);
  });

  it("autolinks a bare https URL", () => {
    expect(parseMessageSegments("see https://x.com/a/status/2 ok")).toEqual([
      { type: "text", value: "see " },
      { type: "link", label: "https://x.com/a/status/2", href: "https://x.com/a/status/2" },
      { type: "text", value: " ok" },
    ]);
  });

  it("handles multiple links", () => {
    const segs = parseMessageSegments("[a](https://x.com/1) and [b](https://x.com/2)");
    expect(segs.filter((s) => s.type === "link")).toHaveLength(2);
  });

  it("does NOT linkify javascript: URLs (stays plain text)", () => {
    const segs = parseMessageSegments("[x](javascript:alert(1))");
    expect(segs.every((s) => s.type === "text")).toBe(true);
  });

  it("does not linkify a bare non-http scheme", () => {
    expect(parseMessageSegments("mailto:a@b.com")).toEqual([
      { type: "text", value: "mailto:a@b.com" },
    ]);
  });

  it("preserves newlines inside text segments", () => {
    const segs = parseMessageSegments("line1\nline2 https://x.com/3");
    expect(segs[0]).toEqual({ type: "text", value: "line1\nline2 " });
  });
});
