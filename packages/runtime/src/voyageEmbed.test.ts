import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { voyageEmbed } from "./voyageEmbed.js";

/**
 * These tests MOCK global `fetch` — no live network. They also exercise the
 * env-default path (`VOYAGE_API_KEY` read from `process.env`), the real
 * production wiring, so we save/restore env around each test.
 */

function embedResponse(
  rows: Array<{ index: number; embedding: number[] }>,
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

describe("voyageEmbed — success path", () => {
  it("returns one vector per text, re-projected into input order", async () => {
    process.env["VOYAGE_API_KEY"] = "voyage-test-key";
    // Return rows out of order to prove index-based re-projection.
    const fetchMock = vi.fn(async () =>
      embedResponse([
        { index: 1, embedding: [0.1, 0.2] },
        { index: 0, embedding: [0.9, 0.8] },
      ]),
    );
    vi.stubGlobal("fetch", fetchMock);

    const out = await voyageEmbed(["first", "second"]);

    expect(out).toHaveLength(2);
    expect(out[0]).toEqual([0.9, 0.8]); // index 0
    expect(out[1]).toEqual([0.1, 0.2]); // index 1
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("sends the correct request shape, endpoint, and Authorization header", async () => {
    process.env["VOYAGE_API_KEY"] = "secret-key-abc";
    let capturedUrl = "";
    let capturedInit: RequestInit | undefined;
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      capturedUrl = url;
      capturedInit = init;
      return embedResponse([{ index: 0, embedding: [1, 0, 0] }]);
    });
    vi.stubGlobal("fetch", fetchMock);

    await voyageEmbed(["only"]);

    expect(capturedUrl).toBe("https://ai.mongodb.com/v1/embeddings");
    expect(capturedInit?.method).toBe("POST");
    const headers = capturedInit?.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer secret-key-abc");
    expect(headers["Content-Type"]).toBe("application/json");
    const body = JSON.parse(capturedInit?.body as string);
    expect(body).toMatchObject({
      input: ["only"],
      model: "voyage-3-large",
      input_type: "document",
      truncation: true,
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
        return embedResponse([{ index: 0, embedding: [1] }]);
      }),
    );

    await voyageEmbed(["q"], {
      inputType: "query",
      model: "voyage-3",
      outputDimension: 256,
    });
    expect(body["input_type"]).toBe("query");
    expect(body["model"]).toBe("voyage-3");
    expect(body["output_dimension"]).toBe(256);
  });

  it("honors VOYAGE_ENDPOINT override (trailing slash trimmed)", async () => {
    process.env["VOYAGE_API_KEY"] = "k";
    process.env["VOYAGE_ENDPOINT"] = "https://gateway.example.com/v1/";
    let capturedUrl = "";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        capturedUrl = url;
        return embedResponse([{ index: 0, embedding: [1] }]);
      }),
    );

    await voyageEmbed(["x"]);
    expect(capturedUrl).toBe("https://gateway.example.com/v1/embeddings");
  });

  it("accepts an explicit apiKey opt (overrides env)", async () => {
    let auth = "";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        auth = (init?.headers as Record<string, string>)["Authorization"] ?? "";
        return embedResponse([{ index: 0, embedding: [1] }]);
      }),
    );

    await voyageEmbed(["x"], { apiKey: "explicit-key" });
    expect(auth).toBe("Bearer explicit-key");
  });
});

describe("voyageEmbed — fail-open (returns [], never throws)", () => {
  it("returns [] when the key is unset, without calling fetch", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const out = await voyageEmbed(["a", "b"]);

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

    const out = await voyageEmbed(["a", "b"]);
    expect(out).toEqual([]);
  });

  it("returns [] on a non-2xx response", async () => {
    process.env["VOYAGE_API_KEY"] = "k";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("rate limited", { status: 429 })),
    );

    const out = await voyageEmbed(["a"]);
    expect(out).toEqual([]);
  });

  it("returns [] on a malformed / empty body", async () => {
    process.env["VOYAGE_API_KEY"] = "k";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ nope: true }), { status: 200 })),
    );

    const out = await voyageEmbed(["a", "b"]);
    expect(out).toEqual([]);
  });

  it("returns [] when the response row count doesn't match the input", async () => {
    process.env["VOYAGE_API_KEY"] = "k";
    // Asked for 3, got 2 → partial → fail open rather than return holes.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        embedResponse([
          { index: 0, embedding: [1] },
          { index: 1, embedding: [2] },
        ]),
      ),
    );

    const out = await voyageEmbed(["a", "b", "c"]);
    expect(out).toEqual([]);
  });

  it("returns [] when the 10s timeout fires (abort)", async () => {
    vi.useFakeTimers();
    process.env["VOYAGE_API_KEY"] = "k";

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

    const promise = voyageEmbed(["a", "b"]);
    await vi.advanceTimersByTimeAsync(10_001);

    const out = await promise;
    expect(out).toEqual([]);
  });
});

describe("voyageEmbed — edge cases", () => {
  it("returns [] for an empty text list without calling fetch", async () => {
    process.env["VOYAGE_API_KEY"] = "k";
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const out = await voyageEmbed([]);
    expect(out).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
