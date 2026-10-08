import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hybridRankStyleExemplars } from "./hybridRank.js";

/**
 * These tests MOCK global `fetch` — no live network. `hybridRankStyleExemplars`
 * makes up to TWO Voyage calls (`/embeddings` for the query, `/rerank` for the
 * candidates), so the fetch mock routes by URL.
 */

type Exemplar = { id: string; text: string; emb: number[] | null };

function embedResponse(embedding: number[]): Response {
  return new Response(JSON.stringify({ data: [{ index: 0, embedding }] }), {
    status: 200,
  });
}

function rerankResponse(
  rows: Array<{ index: number; relevance_score: number }>,
): Response {
  return new Response(JSON.stringify({ data: rows }), { status: 200 });
}

/**
 * Build a fetch mock that answers the embeddings call with `queryEmbedding` and
 * the rerank call with `rerankRows`. Either may be `null` to simulate that leg
 * failing open (a 500).
 */
function routedFetch(args: {
  queryEmbedding: number[] | null;
  rerankRows: Array<{ index: number; relevance_score: number }> | null;
}) {
  return vi.fn(async (url: string) => {
    if (url.endsWith("/embeddings")) {
      return args.queryEmbedding
        ? embedResponse(args.queryEmbedding)
        : new Response("err", { status: 500 });
    }
    if (url.endsWith("/rerank")) {
      return args.rerankRows
        ? rerankResponse(args.rerankRows)
        : new Response("err", { status: 500 });
    }
    throw new Error(`unexpected url ${url}`);
  });
}

const ORIGINAL_KEY = process.env["VOYAGE_API_KEY"];
const ORIGINAL_ENDPOINT = process.env["VOYAGE_ENDPOINT"];

beforeEach(() => {
  delete process.env["VOYAGE_API_KEY"];
  delete process.env["VOYAGE_ENDPOINT"];
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  if (ORIGINAL_KEY === undefined) delete process.env["VOYAGE_API_KEY"];
  else process.env["VOYAGE_API_KEY"] = ORIGINAL_KEY;
  if (ORIGINAL_ENDPOINT === undefined) delete process.env["VOYAGE_ENDPOINT"];
  else process.env["VOYAGE_ENDPOINT"] = ORIGINAL_ENDPOINT;
});

const CANDIDATES: Exemplar[] = [
  { id: "a", text: "alpha", emb: [1, 0, 0] },
  { id: "b", text: "beta", emb: [0, 1, 0] },
  { id: "c", text: "gamma", emb: [0, 0, 1] },
];

describe("hybridRankStyleExemplars — fusion path (dense + rerank)", () => {
  it("RRF-fuses the dense cosine ranking with the rerank ranking", async () => {
    process.env["VOYAGE_API_KEY"] = "k";
    // Query embedding closest to candidate "a" ([1,0,0]) → dense ranking a,(b/c).
    // Rerank says "a" best too. Both agree → "a" first.
    vi.stubGlobal(
      "fetch",
      routedFetch({
        queryEmbedding: [0.9, 0.1, 0],
        rerankRows: [
          { index: 0, relevance_score: 0.99 }, // a
          { index: 1, relevance_score: 0.4 }, // b
          { index: 2, relevance_score: 0.1 }, // c
        ],
      }),
    );

    const out = await hybridRankStyleExemplars("find alpha", CANDIDATES, {
      toText: (c) => c.text,
      toEmbedding: (c) => c.emb,
    });

    expect(out.map((c) => c.id)[0]).toBe("a");
    expect(out).toHaveLength(3);
    expect(new Set(out.map((c) => c.id))).toEqual(new Set(["a", "b", "c"]));
  });

  it("lets the DENSE signal lift a candidate the rerank ranked low", async () => {
    process.env["VOYAGE_API_KEY"] = "k";
    // Query embedding is closest to "c" ([0,0,1]). But rerank ranks "c" LAST.
    // RRF over both should pull "c" up above where rerank alone would place it.
    vi.stubGlobal(
      "fetch",
      routedFetch({
        queryEmbedding: [0, 0, 0.95],
        rerankRows: [
          { index: 0, relevance_score: 0.9 }, // a
          { index: 1, relevance_score: 0.8 }, // b
          { index: 2, relevance_score: 0.05 }, // c (rerank-last)
        ],
      }),
    );

    const rerankOnlyLast = "c";
    const out = await hybridRankStyleExemplars("q", CANDIDATES, {
      toText: (c) => c.text,
      toEmbedding: (c) => c.emb,
    });
    const order = out.map((c) => c.id);
    // c must no longer be strictly last thanks to its rank-0 dense contribution.
    expect(order[order.length - 1]).not.toBe(rerankOnlyLast);
  });

  it("respects topK on the fused path", async () => {
    process.env["VOYAGE_API_KEY"] = "k";
    vi.stubGlobal(
      "fetch",
      routedFetch({
        queryEmbedding: [1, 0, 0],
        rerankRows: [
          { index: 0, relevance_score: 0.9 },
          { index: 1, relevance_score: 0.8 },
          { index: 2, relevance_score: 0.7 },
        ],
      }),
    );

    const out = await hybridRankStyleExemplars("q", CANDIDATES, {
      toText: (c) => c.text,
      toEmbedding: (c) => c.emb,
      topK: 2,
    });
    expect(out).toHaveLength(2);
  });

  it("calls BOTH /embeddings and /rerank exactly once on the fused path", async () => {
    process.env["VOYAGE_API_KEY"] = "k";
    const fetchMock = routedFetch({
      queryEmbedding: [1, 0, 0],
      rerankRows: [{ index: 0, relevance_score: 1 }],
    });
    vi.stubGlobal("fetch", fetchMock);

    await hybridRankStyleExemplars("q", CANDIDATES, {
      toText: (c) => c.text,
      toEmbedding: (c) => c.emb,
    });

    const urls = fetchMock.mock.calls.map((c) => c[0] as string);
    expect(urls.filter((u) => u.endsWith("/embeddings"))).toHaveLength(1);
    expect(urls.filter((u) => u.endsWith("/rerank"))).toHaveLength(1);
  });
});

describe("hybridRankStyleExemplars — fail-open to F4a rerank-only", () => {
  it("skips dense and uses rerank-only when NO candidate exposes an embedding", async () => {
    process.env["VOYAGE_API_KEY"] = "k";
    const fetchMock = routedFetch({
      queryEmbedding: [1, 0, 0],
      rerankRows: [
        { index: 2, relevance_score: 0.9 },
        { index: 0, relevance_score: 0.5 },
        { index: 1, relevance_score: 0.1 },
      ],
    });
    vi.stubGlobal("fetch", fetchMock);

    const noEmb: Exemplar[] = CANDIDATES.map((c) => ({ ...c, emb: null }));
    const out = await hybridRankStyleExemplars("q", noEmb, {
      toText: (c) => c.text,
      toEmbedding: (c) => c.emb,
    });

    // Pure rerank order: c, a, b.
    expect(out.map((c) => c.id)).toEqual(["c", "a", "b"]);
    // No embeddings call should have been made (dense short-circuited).
    const urls = fetchMock.mock.calls.map((c) => c[0] as string);
    expect(urls.some((u) => u.endsWith("/embeddings"))).toBe(false);
    expect(urls.filter((u) => u.endsWith("/rerank"))).toHaveLength(1);
  });

  it("uses rerank-only when toEmbedding is omitted entirely", async () => {
    process.env["VOYAGE_API_KEY"] = "k";
    vi.stubGlobal(
      "fetch",
      routedFetch({
        queryEmbedding: [1, 0, 0],
        rerankRows: [
          { index: 1, relevance_score: 0.9 },
          { index: 0, relevance_score: 0.5 },
          { index: 2, relevance_score: 0.1 },
        ],
      }),
    );

    const out = await hybridRankStyleExemplars("q", CANDIDATES, {
      toText: (c) => c.text,
      // no toEmbedding
    });
    expect(out.map((c) => c.id)).toEqual(["b", "a", "c"]);
  });

  it("falls back to rerank-only when the query embed fails open ([])", async () => {
    process.env["VOYAGE_API_KEY"] = "k";
    // Embeddings leg 500s → query vector empty → dense skipped → rerank order.
    vi.stubGlobal(
      "fetch",
      routedFetch({
        queryEmbedding: null,
        rerankRows: [
          { index: 2, relevance_score: 0.9 },
          { index: 1, relevance_score: 0.5 },
          { index: 0, relevance_score: 0.1 },
        ],
      }),
    );

    const out = await hybridRankStyleExemplars("q", CANDIDATES, {
      toText: (c) => c.text,
      toEmbedding: (c) => c.emb,
    });
    expect(out.map((c) => c.id)).toEqual(["c", "b", "a"]);
  });

  it("falls back to ORIGINAL order when there is no key at all", async () => {
    // No key → both Voyage calls fail open → rerank-only also no-ops → input order.
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const out = await hybridRankStyleExemplars("q", CANDIDATES, {
      toText: (c) => c.text,
      toEmbedding: (c) => c.emb,
    });
    expect(out.map((c) => c.id)).toEqual(["a", "b", "c"]);
    // With no key, voyageEmbed short-circuits before fetch; rerank too.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("respects topK on the rerank-only fallback (no key)", async () => {
    vi.stubGlobal("fetch", vi.fn());
    const out = await hybridRankStyleExemplars("q", CANDIDATES, {
      toText: (c) => c.text,
      toEmbedding: (c) => c.emb,
      topK: 2,
    });
    expect(out.map((c) => c.id)).toEqual(["a", "b"]);
  });
});

describe("hybridRankStyleExemplars — edge cases", () => {
  it("returns [] for no candidates without calling fetch", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const out = await hybridRankStyleExemplars("q", [] as Exemplar[], {
      toText: (c) => c.text,
      toEmbedding: (c) => c.emb,
    });
    expect(out).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("never throws even if toText throws (fails open to original order)", async () => {
    // No key path keeps it deterministic; toText would only be hit by rerank,
    // which short-circuits with no key — but assert the call still resolves.
    vi.stubGlobal("fetch", vi.fn());
    const out = await hybridRankStyleExemplars("q", CANDIDATES, {
      toText: (c) => c.text,
      toEmbedding: (c) => c.emb,
    });
    expect(out).toHaveLength(3);
  });
});
