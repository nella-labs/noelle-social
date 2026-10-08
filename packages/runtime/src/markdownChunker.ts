/**
 * Markdown chunker — splits a markdown body into heading-scoped chunks
 * suitable for BM25 indexing in the GCS-backed Nella shim.
 *
 * Why this exists: whole-file scoring buries the actually-relevant
 * paragraph in 5KB of unrelated context. The drafter needs the specific
 * section ("Pattern 2: negative hook") not the whole file
 * (`script-patterns.md`).
 *
 * Splitting rules:
 *   1. Strip a leading YAML frontmatter block (`---` ... `---`).
 *   2. Split the remainder at `##` heading boundaries — the heading line
 *      and everything until the next `##` (or EOF) become one chunk.
 *      The H1 (`# `) introduces the file's title chunk; everything
 *      before the first `##` (including the H1 and any intro prose)
 *      becomes the first chunk with `headingPath = ["<H1 text>"]`
 *      (or `[]` if there is no H1).
 *   3. If a chunk exceeds `MAX_CHUNK_CHARS` (~2400, ≈600 tokens at 4
 *      chars/token), recursively split by `###` headings first, then by
 *      blank-line paragraph boundaries, packing paragraphs greedily up
 *      to the cap.
 *
 * Each chunk knows its file path, the heading stack at its location
 * (e.g. `["Short-form script patterns", "Pattern 2: negative hook"]`),
 * and its 1-indexed start/end line numbers in the original body (BEFORE
 * frontmatter strip — so line numbers map back to what an operator sees
 * in `git blame` / `gcloud storage cat`).
 *
 * Pure function. No I/O. Deterministic. Embeddings are an explicit
 * future option but out of scope here; the chunk shape is designed to
 * be embeddable later without re-chunking.
 */

export const MAX_CHUNK_CHARS = 2400;

export interface MarkdownChunk {
  /** Source path within its corpus (e.g. `02-brand/voice.md`). */
  filePath: string;
  /** The chunk's text body, including its heading line if any. */
  body: string;
  /**
   * Heading stack at the chunk's position, outermost first.
   * Empty array for a chunk that lives before any heading.
   */
  headingPath: ReadonlyArray<string>;
  /** 1-indexed first line of the chunk in the original (pre-strip) body. */
  startLine: number;
  /** 1-indexed last line of the chunk in the original body (inclusive). */
  endLine: number;
}

export function chunkMarkdown(
  filePath: string,
  body: string,
): ReadonlyArray<MarkdownChunk> {
  if (!body) return [];

  const stripped = stripFrontmatter(body);
  if (!stripped.text.trim()) return [];

  const sections = splitByH2(stripped.text, stripped.startLine);
  const chunks: MarkdownChunk[] = [];
  let h1Title: string | null = null;

  for (const section of sections) {
    let headingPath: string[];
    if (section.kind === "preamble") {
      const h1Match = /^# (.+)$/m.exec(section.body);
      if (h1Match?.[1]) {
        h1Title = h1Match[1].trim();
        headingPath = [h1Title];
      } else {
        headingPath = [];
      }
    } else {
      const firstLine = section.body.split("\n", 1)[0] ?? "";
      const h2Match = /^## (.+)$/.exec(firstLine);
      const h2Title = h2Match?.[1]?.trim() ?? "";
      headingPath = h1Title ? [h1Title, h2Title] : [h2Title];
    }
    for (const piece of splitOversized(filePath, section, headingPath)) {
      chunks.push(piece);
    }
  }
  return chunks;
}

interface RawSection {
  kind: "preamble" | "h2";
  body: string;
  startLine: number;
  endLine: number;
}

/**
 * Split a markdown body into a leading "preamble" (everything before the
 * first `##`) and one section per `##` heading. Trailing whitespace-only
 * lines are dropped from each section. Code-fence-aware: `##` inside a
 * fenced code block is ignored.
 */
function splitByH2(text: string, baseLine: number): RawSection[] {
  const lines = text.split("\n");
  const sections: RawSection[] = [];
  let inFence = false;
  let currentStart = 0;
  let currentKind: "preamble" | "h2" = "preamble";

  const flush = (endIdxExclusive: number): void => {
    // Trim trailing blank lines from the body, but the chunk owns lines
    // through endIdxExclusive - 1 (the line just before the next section
    // or EOF). This keeps endLine consistent with "the next chunk starts
    // at endLine + 1" semantics expected by callers.
    let endIdx = endIdxExclusive - 1;
    while (endIdx > currentStart && lines[endIdx]?.trim() === "") endIdx -= 1;
    const sliceEnd = endIdx + 1;
    const sliceBody = lines.slice(currentStart, sliceEnd).join("\n");
    if (sliceBody.trim() === "") return;
    sections.push({
      kind: currentKind,
      body: sliceBody,
      startLine: baseLine + currentStart,
      endLine: baseLine + endIdxExclusive - 1,
    });
  };

  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i] ?? "";
    if (/^```/.test(ln)) {
      inFence = !inFence;
      continue;
    }
    if (!inFence && /^## /.test(ln)) {
      flush(i);
      currentStart = i;
      currentKind = "h2";
    }
  }
  flush(lines.length);
  return sections;
}

interface Stripped {
  /** Text after frontmatter is removed. */
  text: string;
  /** 1-indexed line number in the original body where `text` starts. */
  startLine: number;
}

/**
 * Strip a YAML frontmatter block: `---\n...\n---\n` only when it is the
 * very first thing in the file. Returns the rest of the body and the
 * 1-indexed line number where the rest begins in the original.
 */
function stripFrontmatter(body: string): Stripped {
  const lines = body.split("\n");
  if (lines[0] !== "---") return { text: body, startLine: 1 };
  let closeIdx = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === "---") {
      closeIdx = i;
      break;
    }
  }
  if (closeIdx < 0) return { text: body, startLine: 1 };
  // The remaining text starts at line (closeIdx + 1) (0-indexed) — but
  // skip a single blank line right after the close marker, since vault
  // files canonically have `---\n\n# Title`.
  let restStart = closeIdx + 1;
  while (restStart < lines.length && lines[restStart] === "") {
    restStart += 1;
  }
  const remaining = lines.slice(restStart).join("\n");
  // Lines are 1-indexed; restStart is 0-indexed.
  return { text: remaining, startLine: restStart + 1 };
}

/**
 * If a section exceeds MAX_CHUNK_CHARS, recursively split: first at `###`
 * sub-heading lines, then by packing paragraphs greedily up to the cap.
 * Each emitted piece keeps the parent `headingPath` (or appends an H3
 * title when split at a `###` boundary). Line numbers stay accurate.
 */
function splitOversized(
  filePath: string,
  section: RawSection,
  headingPath: ReadonlyArray<string>,
): MarkdownChunk[] {
  if (section.body.length <= MAX_CHUNK_CHARS) {
    return [
      {
        filePath,
        body: section.body,
        headingPath,
        startLine: section.startLine,
        endLine: section.endLine,
      },
    ];
  }

  // Try splitting at ### sub-headings first.
