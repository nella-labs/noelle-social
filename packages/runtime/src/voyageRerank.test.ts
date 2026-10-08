import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { voyageRerank, rankStyleExemplars } from "./voyageRerank.js";

/**
 * These tests MOCK global `fetch` — no live network. They also exercise the
 * env-default path (`VOYAGE_API_KEY` read from `process.env`), which is the
 * real production wiring, so we save/restore env around each test.
 */

function rerankResponse(
  rows: Array<{ index: number; relevance_score: number }>,
  status = 200,
): Response {
  return new Response(JSON.stringify({ data: rows }), { status });
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

describe("voyageRerank — success path", () => {
  it("reorders documents by descending relevance score", async () => {
    process.env["VOYAGE_API_KEY"] = "voyage-test-key";
    const fetchMock = vi.fn(async () =>
      // Voyage scores doc 2 highest, then doc 0, then doc 1.
      rerankResponse([
        { index: 2, relevance_score: 0.91 },
        { index: 0, relevance_score: 0.55 },
        { index: 1, relevance_score: 0.12 },
      ]),
    );
    vi.stubGlobal("fetch", fetchMock);

    const out = await voyageRerank("best fit?", ["a", "b", "c"]);

    expect(out.map((r) => r.index)).toEqual([2, 0, 1]);
    expect(out).toHaveLength(3);
    expect(out[0]!.score).toBeGreaterThan(out[1]!.score);
    expect(out[1]!.score).toBeGreaterThan(out[2]!.score);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("sends the correct request shape, endpoint, and Authorization header", async () => {
    process.env["VOYAGE_API_KEY"] = "secret-key-abc";
    let capturedUrl = "";
    let capturedInit: RequestInit | undefined;
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      capturedUrl = url;
      capturedInit = init;
      return rerankResponse([{ index: 0, relevance_score: 1 }]);
    });
    vi.stubGlobal("fetch", fetchMock);

    await voyageRerank("q", ["only"]);

    // Default gateway host + /rerank path.
    expect(capturedUrl).toBe("https://ai.mongodb.com/v1/rerank");
    expect(capturedInit?.method).toBe("POST");
    const headers = capturedInit?.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer secret-key-abc");
    expect(headers["Content-Type"]).toBe("application/json");
    const body = JSON.parse(capturedInit?.body as string);
    expect(body).toMatchObject({
      model: "rerank-2.5",
      query: "q",
      documents: ["only"],
      return_documents: false,
    });
  });

  it("honors VOYAGE_ENDPOINT override (trailing slash trimmed)", async () => {
    process.env["VOYAGE_API_KEY"] = "k";
    process.env["VOYAGE_ENDPOINT"] = "https://gateway.example.com/v1/";
    let capturedUrl = "";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        capturedUrl = url;
        return rerankResponse([{ index: 0, relevance_score: 1 }]);
      }),
    );

    await voyageRerank("q", ["x"]);
    expect(capturedUrl).toBe("https://gateway.example.com/v1/rerank");
  });
});

describe("voyageRerank — fail-open (never throws)", () => {
  it("returns identity order when the key is unset", async () => {
    // No VOYAGE_API_KEY in env, none passed.
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const out = await voyageRerank("q", ["a", "b", "c"]);

    expect(out.map((r) => r.index)).toEqual([0, 1, 2]);
    expect(out).toHaveLength(3);
    // Placeholder scores are strictly descending so a sort is a no-op.
    expect(out[0]!.score).toBeGreaterThan(out[1]!.score);
    expect(out[1]!.score).toBeGreaterThan(out[2]!.score);
    // Critically: no network call attempted without a key.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns identity order when fetch throws (network error)", async () => {
    process.env["VOYAGE_API_KEY"] = "k";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("ECONNREFUSED");
      }),
    );

    const out = await voyageRerank("q", ["a", "b", "c", "d"]);
    expect(out.map((r) => r.index)).toEqual([0, 1, 2, 3]);
  });

  it("returns identity order on a non-2xx response", async () => {
    process.env["VOYAGE_API_KEY"] = "k";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("rate limited", { status: 429 })),
    );

    const out = await voyageRerank("q", ["a", "b"]);
    expect(out.map((r) => r.index)).toEqual([0, 1]);
  });

  it("returns identity order on a malformed / empty body", async () => {
    process.env["VOYAGE_API_KEY"] = "k";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ nope: true }), { status: 200 })),
    );

    const out = await voyageRerank("q", ["a", "b", "c"]);
    expect(out.map((r) => r.index)).toEqual([0, 1, 2]);
  });

  it("returns identity order when the 10s timeout fires (abort)", async () => {
    vi.useFakeTimers();
    process.env["VOYAGE_API_KEY"] = "k";

    // fetch that only settles when its abort signal fires — so the request
    // hangs until the internal 10s timeout aborts it.
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: string, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            const signal = init?.signal;
            if (signal) {
              signal.addEventListener("abort", () => {
                reject(new DOMException("Aborted", "AbortError"));
              });
            }
          }),
      ),
    );

    const promise = voyageRerank("q", ["a", "b", "c"]);
    // Advance past the 10s internal timeout to trigger the abort.
    await vi.advanceTimersByTimeAsync(10_001);

    const out = await promise;
    expect(out.map((r) => r.index)).toEqual([0, 1, 2]);
  });
});

describe("voyageRerank — topK", () => {
  it("passes top_k in the request and respects topK on the success path", async () => {
    process.env["VOYAGE_API_KEY"] = "k";
    let body: { top_k?: number } = {};
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        body = JSON.parse(init?.body as string);
        return rerankResponse([
          { index: 3, relevance_score: 0.9 },
          { index: 1, relevance_score: 0.8 },
        ]);
      }),
    );

    const out = await voyageRerank("q", ["a", "b", "c", "d"], { topK: 2 });
    expect(body.top_k).toBe(2);
    expect(out).toHaveLength(2);
    expect(out.map((r) => r.index)).toEqual([3, 1]);
  });

  it("respects topK on the fail-open path (truncates identity ranking)", async () => {
    // No key → identity, but still truncated to topK.
    vi.stubGlobal("fetch", vi.fn());
    const out = await voyageRerank("q", ["a", "b", "c", "d", "e"], { topK: 2 });
    expect(out.map((r) => r.index)).toEqual([0, 1]);
  });
});

describe("voyageRerank — edge cases", () => {
  it("returns [] for an empty document list without calling fetch", async () => {
    process.env["VOYAGE_API_KEY"] = "k";
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const out = await voyageRerank("q", []);
    expect(out).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("accepts an explicit apiKey opt (overrides env)", async () => {
    let auth = "";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        auth = (init?.headers as Record<string, string>)["Authorization"] ?? "";
        return rerankResponse([{ index: 0, relevance_score: 1 }]);
      }),
    );

    await voyageRerank("q", ["x"], { apiKey: "explicit-key" });
    expect(auth).toBe("Bearer explicit-key");
  });
});

describe("rankStyleExemplars", () => {
  type Exemplar = { id: string; text: string };

  it("reorders candidate objects best-first on the success path", async () => {
    process.env["VOYAGE_API_KEY"] = "k";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        rerankResponse([
          { index: 2, relevance_score: 0.99 },
          { index: 0, relevance_score: 0.5 },
          { index: 1, relevance_score: 0.1 },
        ]),
      ),
    );

    const candidates: Exemplar[] = [
      { id: "one", text: "alpha" },
      { id: "two", text: "beta" },
      { id: "three", text: "gamma" },
    ];
    const out = await rankStyleExemplars("q", candidates, (c) => c.text);
    expect(out.map((c) => c.id)).toEqual(["three", "one", "two"]);
  });

  it("falls back to original order when rerank fails open (no key)", async () => {
    vi.stubGlobal("fetch", vi.fn());
    const candidates: Exemplar[] = [
      { id: "one", text: "alpha" },
      { id: "two", text: "beta" },
    ];
    const out = await rankStyleExemplars("q", candidates, (c) => c.text);
    expect(out.map((c) => c.id)).toEqual(["one", "two"]);
  });

  it("returns [] for no candidates", async () => {
    const out = await rankStyleExemplars("q", [] as Exemplar[], (c) => c.text);
    expect(out).toEqual([]);
  });

  it("respects topK", async () => {
    process.env["VOYAGE_API_KEY"] = "k";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        rerankResponse([
          { index: 1, relevance_score: 0.9 },
          { index: 0, relevance_score: 0.8 },
        ]),
      ),
    );
    const candidates: Exemplar[] = [
      { id: "one", text: "alpha" },
      { id: "two", text: "beta" },
      { id: "three", text: "gamma" },
    ];
    const out = await rankStyleExemplars("q", candidates, (c) => c.text, { topK: 2 });
    expect(out.map((c) => c.id)).toEqual(["two", "one"]);
  });
});
