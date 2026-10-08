import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { voyageContextEmbed, voyageContextEmbedQuery } from "./voyageContextEmbed.js";

/**
 * These tests MOCK global `fetch` — no live network. They exercise the
 * contextualized-embeddings wire shape (`/contextualizedembeddings`, model
 * `voyage-context-4`) and the env-default credential path, so we save/restore
 * env around each test. The response nesting is per-document → per-chunk:
 * `data[docIdx].data[chunkIdx].embedding`.
 */

/** Build a well-formed contextualized-embeddings response from a nested matrix. */
function contextResponse(
  docs: Array<Array<{ index: number; embedding: number[] }>>,
  status = 200,
): Response {
  const data = docs.map((chunks, docIdx) => ({ index: docIdx, data: chunks }));
  return new Response(JSON.stringify({ data, model: "voyage-context-4" }), { status });
}

const ORIGINAL_KEY = process.env["VOYAGE_API_KEY"];
const ORIGINAL_CTX_KEY = process.env["VOYAGE_CONTEXT_API_KEY"];
const ORIGINAL_CTX_ENDPOINT = process.env["VOYAGE_CONTEXT_ENDPOINT"];

beforeEach(() => {
  delete process.env["VOYAGE_API_KEY"];
  delete process.env["VOYAGE_CONTEXT_API_KEY"];
  delete process.env["VOYAGE_CONTEXT_ENDPOINT"];
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  const restore = (k: string, v: string | undefined) => {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  };
  restore("VOYAGE_API_KEY", ORIGINAL_KEY);
  restore("VOYAGE_CONTEXT_API_KEY", ORIGINAL_CTX_KEY);
  restore("VOYAGE_CONTEXT_ENDPOINT", ORIGINAL_CTX_ENDPOINT);
});

describe("voyageContextEmbed — success path", () => {
  it("returns one vector per chunk, grouped by document, re-projected into order", async () => {
    process.env["VOYAGE_API_KEY"] = "voyage-test-key";
    // Two documents: doc0 has 2 chunks, doc1 has 1. Rows out of order within a
    // doc to prove index-based re-projection.
    const fetchMock = vi.fn(async () =>
      contextResponse([
        [
          { index: 1, embedding: [0.3, 0.4] },
          { index: 0, embedding: [0.1, 0.2] },
        ],
        [{ index: 0, embedding: [0.9, 0.8] }],
      ]),
    );
    vi.stubGlobal("fetch", fetchMock);

    const out = await voyageContextEmbed([["a", "b"], ["c"]]);

    expect(out).toHaveLength(2);
    expect(out[0]).toEqual([
      [0.1, 0.2], // doc0 chunk0
      [0.3, 0.4], // doc0 chunk1
    ]);
    expect(out[1]).toEqual([[0.9, 0.8]]); // doc1 chunk0
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("sends the correct request shape, endpoint, and Authorization header", async () => {
    process.env["VOYAGE_API_KEY"] = "secret-key-abc";
    let capturedUrl = "";
    let capturedInit: RequestInit | undefined;
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      capturedUrl = url;
      capturedInit = init;
      return contextResponse([[{ index: 0, embedding: [1, 0, 0] }]]);
    });
    vi.stubGlobal("fetch", fetchMock);

    await voyageContextEmbed([["only"]]);

    // Voyage-direct by default — the MongoDB gateway is not assumed to proxy
    // the contextualized endpoint.
    expect(capturedUrl).toBe("https://api.voyageai.com/v1/contextualizedembeddings");
    expect(capturedInit?.method).toBe("POST");
    const headers = capturedInit?.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer secret-key-abc");
    expect(headers["Content-Type"]).toBe("application/json");
    const body = JSON.parse(capturedInit?.body as string);
    expect(body).toMatchObject({
      inputs: [["only"]],
      model: "voyage-context-4",
      input_type: "document",
      output_dimension: 1024,
    });
  });

  it("honors inputType, model, and outputDimension overrides", async () => {
    process.env["VOYAGE_API_KEY"] = "k";
    let body: Record<string, unknown> = {};
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        body = JSON.parse(init?.body as string);
        return contextResponse([[{ index: 0, embedding: [1] }]]);
      }),
    );

    await voyageContextEmbed([["q"]], {
      inputType: "query",
      model: "voyage-context-3",
      outputDimension: 256,
    });
    expect(body["input_type"]).toBe("query");
    expect(body["model"]).toBe("voyage-context-3");
    expect(body["output_dimension"]).toBe(256);
  });

  it("honors VOYAGE_CONTEXT_ENDPOINT override (trailing slash trimmed)", async () => {
    process.env["VOYAGE_API_KEY"] = "k";
    process.env["VOYAGE_CONTEXT_ENDPOINT"] = "https://gateway.example.com/v1/";
    let capturedUrl = "";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        capturedUrl = url;
        return contextResponse([[{ index: 0, embedding: [1] }]]);
      }),
    );

    await voyageContextEmbed([["x"]]);
    expect(capturedUrl).toBe("https://gateway.example.com/v1/contextualizedembeddings");
  });

  it("prefers VOYAGE_CONTEXT_API_KEY over VOYAGE_API_KEY", async () => {
    process.env["VOYAGE_API_KEY"] = "gateway-key";
    process.env["VOYAGE_CONTEXT_API_KEY"] = "direct-voyage-key";
    let auth = "";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        auth = (init?.headers as Record<string, string>)["Authorization"] ?? "";
        return contextResponse([[{ index: 0, embedding: [1] }]]);
      }),
    );

    await voyageContextEmbed([["x"]]);
    expect(auth).toBe("Bearer direct-voyage-key");
  });

  it("accepts an explicit apiKey opt (overrides env)", async () => {
    process.env["VOYAGE_API_KEY"] = "env-key";
    let auth = "";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        auth = (init?.headers as Record<string, string>)["Authorization"] ?? "";
        return contextResponse([[{ index: 0, embedding: [1] }]]);
      }),
    );

    await voyageContextEmbed([["x"]], { apiKey: "explicit-key" });
    expect(auth).toBe("Bearer explicit-key");
  });
});

describe("voyageContextEmbed — fail-open (returns [], never throws)", () => {
  it("returns [] when the key is unset, without calling fetch", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const out = await voyageContextEmbed([["a"], ["b"]]);

    expect(out).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns [] when fetch throws (network error)", async () => {
    process.env["VOYAGE_API_KEY"] = "k";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("ECONNREFUSED");
      }),
    );

    expect(await voyageContextEmbed([["a"]])).toEqual([]);
  });

  it("returns [] on a non-2xx response", async () => {
    process.env["VOYAGE_API_KEY"] = "k";
    vi.stubGlobal("fetch", vi.fn(async () => new Response("rate limited", { status: 429 })));

    expect(await voyageContextEmbed([["a"]])).toEqual([]);
  });

  it("returns [] on a malformed / empty body", async () => {
    process.env["VOYAGE_API_KEY"] = "k";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ nope: true }), { status: 200 })),
    );

    expect(await voyageContextEmbed([["a"]])).toEqual([]);
  });

  it("returns [] when a document's chunk count doesn't match the input", async () => {
    process.env["VOYAGE_API_KEY"] = "k";
    // Asked for 2 chunks in doc0, got 1 → partial → fail open rather than holes.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => contextResponse([[{ index: 0, embedding: [1] }]])),
    );

    expect(await voyageContextEmbed([["a", "b"]])).toEqual([]);
  });

  it("returns [] when the document count doesn't match the input", async () => {
    process.env["VOYAGE_API_KEY"] = "k";
    // Asked for 2 docs, got 1 → fail open.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => contextResponse([[{ index: 0, embedding: [1] }]])),
    );

    expect(await voyageContextEmbed([["a"], ["b"]])).toEqual([]);
  });

  it("returns [] when the 10s timeout fires (abort)", async () => {
    vi.useFakeTimers();
    process.env["VOYAGE_API_KEY"] = "k";
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: string, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => {
              reject(new DOMException("Aborted", "AbortError"));
            });
          }),
      ),
    );

    const promise = voyageContextEmbed([["a"]]);
    await vi.advanceTimersByTimeAsync(10_001);
    expect(await promise).toEqual([]);
  });
});

describe("voyageContextEmbed — edge cases", () => {
  it("returns [] for an empty document list without calling fetch", async () => {
    process.env["VOYAGE_API_KEY"] = "k";
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    expect(await voyageContextEmbed([])).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns [] when every document is empty (no chunks to embed)", async () => {
    process.env["VOYAGE_API_KEY"] = "k";
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    expect(await voyageContextEmbed([[], []])).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("voyageContextEmbedQuery — single-vector convenience", () => {
  it("embeds one query string (input_type=query) and returns its vector", async () => {
    process.env["VOYAGE_API_KEY"] = "k";
    let body: Record<string, unknown> = {};
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        body = JSON.parse(init?.body as string);
        return contextResponse([[{ index: 0, embedding: [0.5, 0.5] }]]);
      }),
    );

    const vec = await voyageContextEmbedQuery("how do we ground drafts");
    expect(vec).toEqual([0.5, 0.5]);
    expect(body["inputs"]).toEqual([["how do we ground drafts"]]);
    expect(body["input_type"]).toBe("query");
  });

  it("fails open to [] on a blank query (no fetch) and on any error", async () => {
    process.env["VOYAGE_API_KEY"] = "k";
    const fetchMock = vi.fn(async () => {
      throw new Error("boom");
    });
    vi.stubGlobal("fetch", fetchMock);

    expect(await voyageContextEmbedQuery("   ")).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await voyageContextEmbedQuery("real query")).toEqual([]);
  });
});
