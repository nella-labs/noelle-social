import { describe, it, expect, vi } from "vitest";
import { retrieveAnchors } from "./grounding.js";
import type { KbHit } from "@noelle/runtime";

function hit(snippet: string, score: number): KbHit {
  return { snippet, score, highlights: [], source: { filePath: "f.md", startLine: 1, endLine: 2 } };
}

/** A fake KB that returns the given hits, honoring the topK arg like the real one. */
function fakeKb(hits: KbHit[]) {
  return {
    search: async (_q: string, topK = hits.length): Promise<KbHit[]> => hits.slice(0, topK),
  };
}

/** A fake Voyage /rerank response reordering documents by the given index order. */
function rerankResponse(order: Array<{ index: number; relevance_score: number }>): typeof fetch {
  return (async () =>
    new Response(JSON.stringify({ data: order }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;
}

describe("retrieveAnchors", () => {
  it("rerank off → plain BM25 topK, no Voyage call", async () => {
    const fetchImpl = vi.fn();
    const res = await retrieveAnchors(fakeKb([hit("a", 3), hit("b", 2), hit("c", 1)]), "q", {
      topK: 2,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(res.map((h) => h.snippet)).toEqual(["a", "b"]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rerank on → reorders by Voyage relevance, returns topK", async () => {
    const hits = [hit("a", 3), hit("b", 2), hit("c", 1), hit("d", 0)];
    // Voyage ranks doc index 2 (c) first, then index 0 (a).
    const fetchImpl = rerankResponse([
      { index: 2, relevance_score: 0.9 },
      { index: 0, relevance_score: 0.8 },
    ]);
    const res = await retrieveAnchors(fakeKb(hits), "q", {
      topK: 2,
      rerank: true,
      apiKey: "k",
      fetchImpl,
    });
    expect(res.map((h) => h.snippet)).toEqual(["c", "a"]);
  });

  it("rerank on but pool ≤ topK → returns pool unchanged, no Voyage call", async () => {
    const fetchImpl = vi.fn();
    const res = await retrieveAnchors(fakeKb([hit("a", 1), hit("b", 1)]), "q", {
      topK: 5,
      rerank: true,
      apiKey: "k",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(res.length).toBe(2);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rerank failure → fail-open to BM25 order", async () => {
    const hits = [hit("a", 3), hit("b", 2), hit("c", 1)];
    const fetchImpl = (async () => new Response("err", { status: 500 })) as unknown as typeof fetch;
    const res = await retrieveAnchors(fakeKb(hits), "q", {
      topK: 2,
      rerank: true,
      apiKey: "k",
      fetchImpl,
    });
    expect(res.map((h) => h.snippet)).toEqual(["a", "b"]);
  });
});
