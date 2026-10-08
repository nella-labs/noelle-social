import { describe, expect, it, vi } from "vitest";
import { makeLlmBackendResolver, type LlmBackendQuery } from "./llmBackendResolver.js";

/**
 * Build a fake postgres.js-shaped tagged-template client that returns `rows`
 * (or throws `throws`). Tracks call count so we can assert caching.
 */
function fakeQuery(opts: {
  rows?: ReadonlyArray<{ llm_backend?: string | null }>;
  throws?: Error;
}): LlmBackendQuery & { calls: number } {
  const fn = vi.fn(async () => {
    if (opts.throws) throw opts.throws;
    return opts.rows ?? [];
  }) as unknown as LlmBackendQuery & { calls: number };
  Object.defineProperty(fn, "calls", { get: () => (fn as unknown as { mock: { calls: unknown[] } }).mock.calls.length });
  return fn;
}

describe("makeLlmBackendResolver", () => {
  it("returns the column value when the row exists", async () => {
    const resolveAws = makeLlmBackendResolver(fakeQuery({ rows: [{ llm_backend: "aws" }] }));
    expect(await resolveAws("org_1")).toBe("aws");

    const resolveClaude = makeLlmBackendResolver(fakeQuery({ rows: [{ llm_backend: "claude" }] }));
    expect(await resolveClaude("org_1")).toBe("claude");
  });

  it("defaults to 'claude' on a missing row", async () => {
    const resolve = makeLlmBackendResolver(fakeQuery({ rows: [] }));
    expect(await resolve("org_missing")).toBe("claude");
  });

  it("defaults to 'claude' on a null column value", async () => {
    const resolve = makeLlmBackendResolver(fakeQuery({ rows: [{ llm_backend: null }] }));
    expect(await resolve("org_1")).toBe("claude");
  });

  it("defaults to 'claude' on an unexpected column value", async () => {
    const resolve = makeLlmBackendResolver(fakeQuery({ rows: [{ llm_backend: "weird" }] }));
    expect(await resolve("org_1")).toBe("claude");
  });

  it("defaults to 'claude' when the query throws (fail toward current behavior)", async () => {
    const resolve = makeLlmBackendResolver(fakeQuery({ throws: new Error("db down") }));
    expect(await resolve("org_1")).toBe("claude");
  });

  it("caches within the TTL — a second call does not re-query", async () => {
    const q = fakeQuery({ rows: [{ llm_backend: "aws" }] });
    const resolve = makeLlmBackendResolver(q, { ttlMs: 10_000 });
    expect(await resolve("org_1")).toBe("aws");
    expect(await resolve("org_1")).toBe("aws");
    expect(q.calls).toBe(1);
  });

  it("re-queries after the TTL expires", async () => {
    vi.useFakeTimers();
    try {
      const q = fakeQuery({ rows: [{ llm_backend: "aws" }] });
      const resolve = makeLlmBackendResolver(q, { ttlMs: 1_000 });
      expect(await resolve("org_1")).toBe("aws");
      vi.advanceTimersByTime(1_001);
      expect(await resolve("org_1")).toBe("aws");
      expect(q.calls).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("caches distinct orgIds independently", async () => {
    const fn = vi.fn(async (_s: TemplateStringsArray, orgId: string) => {
      return orgId === "org_aws" ? [{ llm_backend: "aws" }] : [{ llm_backend: "claude" }];
    }) as unknown as LlmBackendQuery;
    const resolve = makeLlmBackendResolver(fn, { ttlMs: 10_000 });
    expect(await resolve("org_aws")).toBe("aws");
    expect(await resolve("org_claude")).toBe("claude");
    // Each distinct org queried once; cached thereafter.
    expect(await resolve("org_aws")).toBe("aws");
    expect((fn as unknown as { mock: { calls: unknown[] } }).mock.calls.length).toBe(2);
  });
});
