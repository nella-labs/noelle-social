import { describe, it, expect, vi } from "vitest";
import {
  createNellaClient,
  filePathInDirs,
  NellaError,
  NellaAuthError,
} from "./nellaClient.js";

const WORKSPACE = "mars-demooperator";
const API_KEY = "nla_test_key";

function makeSearchEnvelope(overrides?: Record<string, unknown>) {
  return {
    data: {
      results: [
        {
          chunk: {
            id: "chunk_abc",
            filePath: "vault/posts/2025-04-12.md",
            content: "Shipping daily is the only thing that matters here.",
            language: "markdown",
            startLine: 12,
            endLine: 48,
            symbols: [],
            metadata: { mtime: "2025-04-12T14:22:01Z" },
          },
          score: 0.81,
          scores: { semantic: 0.79, lexical: 0.42, combined: 0.81, reranked: 0.86 },
          highlights: ["...shipping daily is the only thing that matters..."],
        },
      ],
      query: "voice anchors about shipping daily",
      totalMatches: 1,
      searchTime: 312,
      tokensUsed: 1840,
      cost: 0.0008,
      confidence: 0.78,
      suggestion: "use_results",
    },
    meta: { requestId: "req_test" },
    ...overrides,
  };
}

function makeFetch(status: number, body: unknown): typeof fetch {
  return vi.fn().mockImplementation(async () => Response.json(body, { status }));
}

describe("nellaClient", () => {
  describe("searchContext", () => {
    it("happy path — maps the response envelope into Hit[]", async () => {
      const fetchImpl = makeFetch(200, makeSearchEnvelope());
      const client = createNellaClient({ apiKey: API_KEY, fetchImpl });

      const hits = await client.searchContext({
        workspace: WORKSPACE,
        query: "voice anchors about shipping daily",
      });

      expect(hits).toHaveLength(1);
      expect(hits[0]).toEqual({
        path: "vault/posts/2025-04-12.md",
        snippet: "...shipping daily is the only thing that matters...",
        score: 0.81,
        filePath: "vault/posts/2025-04-12.md",
        startLine: 12,
        endLine: 48,
        highlights: ["...shipping daily is the only thing that matters..."],
      });
    });

    it("translates workspace to workspaceId in the request body", async () => {
      const fetchImpl = makeFetch(200, makeSearchEnvelope());
      const client = createNellaClient({ apiKey: API_KEY, fetchImpl });

      await client.searchContext({ workspace: WORKSPACE, query: "test" });

      const [, init] = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0] as [
        string,
        RequestInit,
      ];
      const body = JSON.parse(init.body as string) as Record<string, unknown>;
      expect(body).toHaveProperty("workspaceId", WORKSPACE);
      expect(body).not.toHaveProperty("workspace");
    });

    it("throws NellaAuthError on 401", async () => {
      const fetchImpl = makeFetch(401, { error: "Unauthorized" });
      const client = createNellaClient({ apiKey: API_KEY, fetchImpl });

      await expect(
        client.searchContext({ workspace: WORKSPACE, query: "test" }),
      ).rejects.toBeInstanceOf(NellaAuthError);
    });

    it("throws NellaAuthError on 403", async () => {
      const fetchImpl = makeFetch(403, { error: "Forbidden" });
      const client = createNellaClient({ apiKey: API_KEY, fetchImpl });

      await expect(
        client.searchContext({ workspace: WORKSPACE, query: "test" }),
      ).rejects.toBeInstanceOf(NellaAuthError);
    });

    it("throws NellaError (not NellaAuthError) on 500", async () => {
      const fetchImpl = makeFetch(500, { error: "Internal Server Error" });
      const client = createNellaClient({ apiKey: API_KEY, fetchImpl });

      await expect(
        client.searchContext({ workspace: WORKSPACE, query: "test" }),
      ).rejects.toSatisfy((err: unknown) => {
        return err instanceof NellaError && !(err instanceof NellaAuthError);
      });
    });

    it("throws NellaError with status in message on 500", async () => {
      const fetchImpl = makeFetch(500, {});
      const client = createNellaClient({ apiKey: API_KEY, fetchImpl });

      await expect(
        client.searchContext({ workspace: WORKSPACE, query: "test" }),
      ).rejects.toThrow("500");
    });

    it("throws NellaError on malformed body missing data.results", async () => {
      const fetchImpl = makeFetch(200, { data: { unexpected: true } });
      const client = createNellaClient({ apiKey: API_KEY, fetchImpl });

      await expect(
        client.searchContext({ workspace: WORKSPACE, query: "test" }),
      ).rejects.toThrow("Nella returned malformed response");
    });

    it("throws NellaError mentioning timeout when fetch hangs beyond timeoutMs", async () => {
      vi.useFakeTimers();
      const abortError = Object.assign(new Error("The operation was aborted"), {
        name: "AbortError",
      });
      const fetchImpl = vi.fn().mockImplementation(
        (_url: string, init: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            if (init.signal) {
              (init.signal as AbortSignal).addEventListener("abort", () => {
                reject(abortError);
              });
            }
          }),
      );
      const client = createNellaClient({
        apiKey: API_KEY,
        fetchImpl,
        timeoutMs: 50,
      });

      const promise = client.searchContext({ workspace: WORKSPACE, query: "test" });
      vi.advanceTimersByTime(51);
      try {
        await expect(promise).rejects.toSatisfy((err: unknown) => {
          return (
            err instanceof NellaError &&
            (err.message.toLowerCase().includes("timeout") ||
              err.message.toLowerCase().includes("timed out"))
          );
        });
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe("ready()", () => {
    it("returns true on 200", async () => {
      const fetchImpl = makeFetch(200, { status: "ready" });
      const client = createNellaClient({ apiKey: API_KEY, fetchImpl });

      expect(await client.ready()).toBe(true);
    });

    it("returns false on 503", async () => {
      const fetchImpl = makeFetch(503, { status: "degraded" });
      const client = createNellaClient({ apiKey: API_KEY, fetchImpl });

      expect(await client.ready()).toBe(false);
    });

    it("returns false when fetch throws", async () => {
      const fetchImpl = vi.fn().mockRejectedValue(new Error("Network error"));
      const client = createNellaClient({ apiKey: API_KEY, fetchImpl });

      expect(await client.ready()).toBe(false);
    });
  });

  describe("getAnchors()", () => {
    it("calls /api/v1/search with expected query template and filePattern filter", async () => {
      const fetchImpl = makeFetch(200, makeSearchEnvelope());
      const client = createNellaClient({ apiKey: API_KEY, fetchImpl });

      await client.getAnchors({ workspace: WORKSPACE, handle: "demooperator" });

      const [url, init] = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0] as [
        string,
        RequestInit,
      ];

      expect(url).toContain("/api/v1/search");
      const body = JSON.parse(init.body as string) as Record<string, unknown>;
      expect(body).toHaveProperty("workspaceId", WORKSPACE);
      expect((body["query"] as string).toLowerCase()).toContain("@demooperator");
      expect(body["filters"]).toEqual({ filePattern: "vault/posts/**" });
    });

    it("maps hits to Anchors with empty recency and tags", async () => {
      const fetchImpl = makeFetch(200, makeSearchEnvelope());
      const client = createNellaClient({ apiKey: API_KEY, fetchImpl });

      const anchors = await client.getAnchors({
        workspace: WORKSPACE,
        handle: "demooperator",
      });

      expect(anchors).toHaveLength(1);
      expect(anchors[0]).toMatchObject({
        path: "vault/posts/2025-04-12.md",
        recency: "",
        tags: [],
      });
    });
  });
});

describe("filePathInDirs (vault-subdir scoping)", () => {
  it("absent / empty filterDirs → no scoping (always true)", () => {
    expect(filePathInDirs("02-brand/voice.md")).toBe(true);
    expect(filePathInDirs("02-brand/voice.md", [])).toBe(true);
  });

  it("a prefix matches its own subtree but not a same-stem sibling", () => {
    expect(filePathInDirs("02-brand/voice.md", ["02-brand"])).toBe(true);
    expect(filePathInDirs("02-brand", ["02-brand"])).toBe(true); // the dir itself
    // "02-brand" must NOT match "01-business/..." nor "02-branding/..."
    expect(filePathInDirs("01-business/x.md", ["02-brand"])).toBe(false);
    expect(filePathInDirs("02-branding/x.md", ["02-brand"])).toBe(false);
  });

  it("normalizes leading ./ and / and is case-insensitive", () => {
    expect(filePathInDirs("./02-Brand/voice.md", ["02-brand"])).toBe(true);
    expect(filePathInDirs("/02-brand/voice.md", ["02-brand"])).toBe(true);
    expect(filePathInDirs("02-brand/voice.md", ["./02-brand/"])).toBe(true);
    expect(filePathInDirs("02-brand/voice.md", ["/02-BRAND"])).toBe(true);
  });

  it("matches if ANY prefix in the list matches", () => {
    expect(filePathInDirs("knowledge/api.md", ["voice", "knowledge"])).toBe(true);
    expect(filePathInDirs("misc/api.md", ["voice", "knowledge"])).toBe(false);
  });

  it("fails open on a malformed filePath (excludes, never throws)", () => {
    expect(filePathInDirs("", ["02-brand"])).toBe(false);
    // @ts-expect-error — exercising the runtime guard against non-string input
    expect(filePathInDirs(undefined, ["02-brand"])).toBe(false);
    // A blank/garbage prefix is skipped rather than matching everything.
    expect(filePathInDirs("02-brand/voice.md", ["", "  /  "])).toBe(false);
  });
});
