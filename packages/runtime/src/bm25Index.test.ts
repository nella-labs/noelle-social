import { describe, it, expect } from "vitest";
import { buildChunkIndex, type ChunkIndex } from "./bm25Index.js";
import type { MarkdownChunk } from "./markdownChunker.js";

function chunk(filePath: string, body: string, headingPath: string[] = []): MarkdownChunk {
  return { filePath, body, headingPath, startLine: 1, endLine: body.split("\n").length };
}

describe("bm25Index — module contract", () => {
  it("buildChunkIndex returns a ChunkIndex with a search method", () => {
    const idx: ChunkIndex = buildChunkIndex([]);
    expect(typeof idx.search).toBe("function");
  });

  it("empty index returns no results", () => {
    const idx = buildChunkIndex([]);
    expect(idx.search("anything", 5)).toEqual([]);
  });

  it("returns chunks ranked by BM25 for a query that matches", () => {
    const chunks = [
      chunk("a.md", "shipping daily is the only way to win"),
      chunk("b.md", "marketing strategy and brand positioning"),
      chunk("c.md", "daily shipping shipping. ship daily."),
    ];
    const idx = buildChunkIndex(chunks);
    const results = idx.search("shipping daily", 5);
    expect(results.length).toBeGreaterThan(0);
    // c.md repeats the terms — should rank above a.md.
    expect(results[0]?.chunk.filePath).toBe("c.md");
    // b.md has no matching terms — should not appear.
    expect(results.map((r) => r.chunk.filePath)).not.toContain("b.md");
  });

  it("returns highlights (matched terms) for each hit", () => {
    const chunks = [chunk("a.md", "shipping daily is the only way")];
    const idx = buildChunkIndex(chunks);
    const [hit] = idx.search("shipping", 1);
    expect(hit).toBeDefined();
    expect(hit?.highlights).toContain("shipping");
  });

  it("respects topK", async () => {
    const chunks = Array.from({ length: 12 }, (_, i) =>
      chunk(`p${i}.md`, "shipping daily wins"),
    );
    const idx = buildChunkIndex(chunks);
    expect(idx.search("shipping", 5)).toHaveLength(5);
  });

  it("scores chunks with semantically-related stems together (when stemming is enabled)", () => {
    // "shipping" and "ships" share a stem; BM25 + stemming should match.
    // Implementation choice: stemming is enabled. If this changes, delete
    // this test and document the choice in bm25Index.ts.
    const chunks = [
      chunk("a.md", "ships every day"),
      chunk("b.md", "marketing brand"),
    ];
    const idx = buildChunkIndex(chunks);
    const results = idx.search("shipping", 5);
    expect(results.map((r) => r.chunk.filePath)).toContain("a.md");
    expect(results.map((r) => r.chunk.filePath)).not.toContain("b.md");
  });
});

describe("bm25Index — score normalization (query-length independence)", () => {
  // Bug: the drafter's relevance gate compares max(anchor.score) to a fixed
  // threshold, but MiniSearch's PUBLIC score is `innerSum * queryTerms.length`
  // (its "quality" multiplier, dist/es/index.js:1289-1294). The drafter queries
  // with the ENTIRE post text, so a long keyword-dense chunk that incidentally
  // matches many query terms scores astronomically (live: 233 … 108_573), making
  // the threshold a no-op. The fix divides the public score by queryTerms.length,
  // cancelling the artificial multiplier while keeping honest coverage growth.
  it("cancels MiniSearch's quality multiplier so score grows ~linearly (not ~quadratically) with matched-term count", () => {
    // One doc of 10 distinct rare tokens. Querying 1 token vs all 10 tokens makes
    // the same doc match 1 vs 10 query terms. idf is identical for every token in
    // a single-doc index, so it cancels in the ratio — isolating the multiplier.
    const idx = buildChunkIndex([
      chunk("a.md", "alpha bravo charlie delta echo foxtrot golf hotel india juliet"),
    ]);
    const one = idx.search("alpha", 1)[0]?.score ?? 0;
    const ten =
      idx.search("alpha bravo charlie delta echo foxtrot golf hotel india juliet", 1)[0]
        ?.score ?? 0;
    expect(one).toBeGreaterThan(0);
    expect(ten).toBeGreaterThan(0);
    // Raw MiniSearch: ten ≈ 100×one (N²). Normalized: ten ≈ 10×one (N).
    const ratio = ten / one;
    expect(ratio).toBeLessThan(20); // bug: ~100
    expect(ratio).toBeGreaterThan(5); // still rewards coverage; not over-divided to ~1
  });

  it("keeps a strong single-term match on a small, gate-thresholdable scale", () => {
    // A focused match should land in single digits, not the thousands the raw
    // summed score produced — so DRAFTER_RELEVANCE_THRESHOLD can mean something.
    const idx = buildChunkIndex([
      chunk("voice.md", "shipping daily is the only way to win as a solo founder"),
      chunk("other.md", "marketing strategy and brand positioning frameworks"),
    ]);
    const top = idx.search("shipping daily solo founder", 5)[0];
    expect(top?.chunk.filePath).toBe("voice.md");
    expect(top!.score).toBeLessThan(10);
  });
});
