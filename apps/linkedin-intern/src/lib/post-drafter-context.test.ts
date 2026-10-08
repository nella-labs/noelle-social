import { describe, expect, it } from "vitest";
import type { KnowledgeBase } from "@noelle/runtime";
import { boundedPostKnowledgeAnchors, gatherPostKnowledgeAnchors } from "./post-drafter-context.js";

describe("post knowledge retrieval", () => {
  it("retrieves bounded facts from configured knowledge directories without empty evidence", async () => {
    const kb: KnowledgeBase = {
      ready: async () => true,
      search: async (_query, topK, opts) => {
        if (topK !== 8 || opts?.filterDirs?.join(",") !== "facts")
          throw new Error("unbounded or unscoped search");
        return [
          {
            snippet: "   ",
            score: 1,
            highlights: [],
            source: { filePath: "facts/empty.md", startLine: 1, endLine: 1 },
          },
          {
            snippet: "p95 fell from 210ms to 180ms",
            score: 1,
            highlights: [],
            source: { filePath: "facts/release.md", startLine: 4, endLine: 5 },
          },
        ];
      },
    };
    expect(await gatherPostKnowledgeAnchors(kb, "cache benchmark", ["facts"], 500)).toEqual([
      "[facts/release.md:4-5] p95 fell from 210ms to 180ms",
    ]);
  });

  it("never promotes unscoped retrieval into factual evidence", async () => {
    const kb: KnowledgeBase = {
      ready: async () => true,
      search: async () => {
        throw new Error("must not search");
      },
    };
    expect(await gatherPostKnowledgeAnchors(kb, "cache", [], 4)).toEqual([]);
    expect(await gatherPostKnowledgeAnchors(kb, "cache", ["facts"], 0)).toEqual([]);
    expect(await gatherPostKnowledgeAnchors(kb, "cache", ["facts"], Number.NaN)).toEqual([]);
  });

  it("deduplicates, normalizes and caps supplied facts before both consumers", () => {
    const anchors = boundedPostKnowledgeAnchors([
      " one\n fact ",
      "one fact",
      "",
      ...Array.from({ length: 12 }, (_, i) => `${i} ${"x".repeat(2000)}`),
    ]);
    expect(anchors).toHaveLength(8);
    expect(anchors[0]).toBe("one fact");
    expect(Math.max(...anchors.map((anchor) => anchor.length))).toBe(800);
  });
});
