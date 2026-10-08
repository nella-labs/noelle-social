import { describe, it, expect } from "vitest";
import { chunkMarkdown, MAX_CHUNK_CHARS, type MarkdownChunk } from "./markdownChunker.js";

describe("chunkMarkdown — module contract", () => {
  it("returns an array of MarkdownChunk for empty input", () => {
    const out: ReadonlyArray<MarkdownChunk> = chunkMarkdown("demooperator/x.md", "");
    expect(Array.isArray(out)).toBe(true);
    expect(out.length).toBe(0);
  });

  it("returns a single chunk for a body with no headings", () => {
    const body = "Just some text. No headings here.";
    const [chunk] = chunkMarkdown("demooperator/x.md", body);
    expect(chunk).toBeDefined();
    expect(chunk?.filePath).toBe("demooperator/x.md");
    expect(chunk?.body).toContain("Just some text");
    expect(chunk?.headingPath).toEqual([]);
    expect(chunk?.startLine).toBe(1);
  });
});

describe("chunkMarkdown — frontmatter", () => {
  it("strips a leading YAML frontmatter block", () => {
    const body = [
      "---",
      "type: voice-guide",
      "status: source-of-truth",
      "---",
      "",
      "# Voice and style",
      "",
      "Direct. Specific.",
    ].join("\n");
    const [chunk] = chunkMarkdown("demooperator/x.md", body);
    expect(chunk).toBeDefined();
    expect(chunk?.body).not.toContain("type: voice-guide");
    expect(chunk?.body).toContain("Voice and style");
  });

  it("preserves original line numbers when frontmatter is stripped", () => {
    const body = [
      "---", // line 1
      "type: x", // line 2
      "---", // line 3
      "", // line 4
      "# Title", // line 5
      "Body text.", // line 6
    ].join("\n");
    const [chunk] = chunkMarkdown("demooperator/x.md", body);
    // First chunk should start at the first non-frontmatter line (5 — the H1).
    expect(chunk?.startLine).toBe(5);
    expect(chunk?.endLine).toBe(6);
  });

  it("treats a non-frontmatter leading --- as content, not frontmatter", () => {
    const body = "---\nThis is just a rule, not frontmatter.\n# Title";
    const [chunk] = chunkMarkdown("demooperator/x.md", body);
    // No closing `---` on its own line, so do not strip.
    expect(chunk?.body).toContain("---");
    expect(chunk?.startLine).toBe(1);
  });

  it("returns empty array if the entire body is only frontmatter", () => {
    const body = "---\ntype: x\n---\n";
    const chunks = chunkMarkdown("demooperator/x.md", body);
    expect(chunks).toEqual([]);
  });
});

describe("chunkMarkdown — ## heading split", () => {
  it("splits a file with two ## sections into two chunks", () => {
    const body = [
      "# Voice and style", // line 1
      "", // line 2
      "Intro paragraph.", // line 3
      "", // line 4
      "## Good textures", // line 5
      "- Concrete numbers.", // line 6
      "- Real timestamps.", // line 7
      "", // line 8
      "## Banned energy", // line 9
      "- Corporate hype.", // line 10
    ].join("\n");
    const chunks = chunkMarkdown("demooperator/x.md", body);
    expect(chunks.length).toBe(3);
    // First chunk: H1 + intro (lines 1–4)
    expect(chunks[0]?.headingPath).toEqual(["Voice and style"]);
    expect(chunks[0]?.body).toContain("Intro paragraph");
    expect(chunks[0]?.startLine).toBe(1);
    expect(chunks[0]?.endLine).toBe(4);
    // Second chunk: ## Good textures
    expect(chunks[1]?.headingPath).toEqual(["Voice and style", "Good textures"]);
    expect(chunks[1]?.body).toContain("Concrete numbers");
    expect(chunks[1]?.startLine).toBe(5);
    expect(chunks[1]?.endLine).toBe(8);
    // Third chunk: ## Banned energy
    expect(chunks[2]?.headingPath).toEqual(["Voice and style", "Banned energy"]);
    expect(chunks[2]?.body).toContain("Corporate hype");
    expect(chunks[2]?.startLine).toBe(9);
    expect(chunks[2]?.endLine).toBe(10);
  });

  it("handles a file with frontmatter + ## sections (real vault shape)", () => {
    const body = [
      "---", // line 1
      "type: voice-guide", // line 2
      "---", // line 3
      "", // line 4
      "# Voice and style", // line 5
      "", // line 6
      "## Good textures", // line 7
      "Concrete numbers.", // line 8
    ].join("\n");
    const chunks = chunkMarkdown("demooperator/x.md", body);
    expect(chunks.length).toBe(2);
    expect(chunks[0]?.startLine).toBe(5);
    expect(chunks[1]?.startLine).toBe(7);
    expect(chunks[1]?.headingPath).toEqual(["Voice and style", "Good textures"]);
  });

  it("falls back to a single chunk when there are no ## headings", () => {
    const body = "# Title\n\nJust an intro and nothing else.";
    const chunks = chunkMarkdown("demooperator/x.md", body);
    expect(chunks.length).toBe(1);
    expect(chunks[0]?.headingPath).toEqual(["Title"]);
  });

  it("treats # inside a code fence as content, not a heading", () => {
    const body = [
      "# Title",
      "",
      "```bash",
      "## This is a comment, not a heading",
      "echo hi",
      "```",
      "",
      "## Real section",
      "Body.",
    ].join("\n");
    const chunks = chunkMarkdown("demooperator/x.md", body);
    expect(chunks.length).toBe(2);
    expect(chunks[1]?.headingPath).toEqual(["Title", "Real section"]);
  });
});

describe("chunkMarkdown — size cap", () => {
  it("splits an oversized ## section at ### sub-headings", () => {
    const big = "x ".repeat(900); // ~1800 chars
    const body = [
      "# Title",
      "## Big section",
      "intro",
      "### Sub one",
      big,
      "### Sub two",
      big,
    ].join("\n");
    const chunks = chunkMarkdown("demooperator/x.md", body);
    // One chunk for the H1 preamble (which has no content of its own, just title),
    // and the ## Big section should split into pieces at ### boundaries.
    const h2Chunks = chunks.filter((c) =>
      c.headingPath[c.headingPath.length - 1]?.startsWith("Big section") ||
      c.headingPath[c.headingPath.length - 1] === "Sub one" ||
      c.headingPath[c.headingPath.length - 1] === "Sub two",
    );
    expect(h2Chunks.length).toBeGreaterThanOrEqual(2);
    expect(h2Chunks.some((c) => c.headingPath.includes("Sub one"))).toBe(true);
    expect(h2Chunks.some((c) => c.headingPath.includes("Sub two"))).toBe(true);
    for (const c of chunks) {
      expect(c.body.length).toBeLessThanOrEqual(MAX_CHUNK_CHARS);
    }
  });

  it("splits an oversized section with no ### at paragraph boundaries", () => {
    // 6 paragraphs of ~600 chars each = ~3600 chars total → must split.
    const paragraph = "lorem ipsum dolor sit amet ".repeat(22); // ~594 chars
    const body = [
      "# Title",
      "## Section",
      paragraph,
      "",
      paragraph,
      "",
      paragraph,
      "",
      paragraph,
      "",
      paragraph,
      "",
      paragraph,
    ].join("\n");
    const chunks = chunkMarkdown("demooperator/x.md", body);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(c.body.length).toBeLessThanOrEqual(MAX_CHUNK_CHARS);
    }
    // All pieces should still carry the headingPath `["Title", "Section"]`.
    const sectionChunks = chunks.filter((c) =>
      c.headingPath.length === 2 && c.headingPath[1] === "Section",
    );
    expect(sectionChunks.length).toBeGreaterThan(1);
  });

  it("preserves line numbers when a section is paragraph-split", () => {
    const paragraph = "lorem ".repeat(200); // ~1200 chars
    const body = [
      "# Title", // line 1
      "## Section", // line 2
      paragraph, // line 3
      "", // line 4
      paragraph, // line 5
      "", // line 6
      paragraph, // line 7
    ].join("\n");
    const chunks = chunkMarkdown("demooperator/x.md", body);
    const split = chunks.filter((c) => c.headingPath.includes("Section"));
    // The first sub-chunk must start at line 2 (the ## line). The last
    // must end at line 7. Sub-chunks must form a non-overlapping cover.
    expect(split[0]?.startLine).toBe(2);
    expect(split[split.length - 1]?.endLine).toBe(7);
    for (let i = 1; i < split.length; i++) {
      const prev = split[i - 1];
      const cur = split[i];
      if (!prev || !cur) continue;
      expect(cur.startLine).toBeGreaterThan(prev.endLine);
    }
  });
});
