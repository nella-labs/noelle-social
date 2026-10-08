import { describe, it, expect, vi } from "vitest";
import { createVaultResolver } from "./vaultResolver.js";
import type { Hit, NellaClient } from "./nellaClient.js";

function makeHit(path: string): Hit {
  return {
    path,
    snippet: `snippet for ${path}`,
    score: 0.9,
    filePath: path,
    startLine: 1,
    endLine: 2,
    highlights: [],
  };
}

function stubNella(hits: Hit[] = []): NellaClient {
  return {
    searchContext: vi.fn(async () => hits),
    getAnchors: vi.fn(async () => []),
    ready: vi.fn(async () => true),
  };
}

const ORG = "11111111-1111-1111-1111-111111111111";

describe("vaultResolver", () => {
  it("resolves orgId to workspace via noelle.vaults and forwards the search", async () => {
    const db = vi.fn(async () => [
      { nella_workspace_id: "mars-demooperator", status: "active" },
    ]);
    const nella = stubNella([makeHit("vault/posts/a.md")]);
    const resolver = createVaultResolver({ db, nella });

    const hits = await resolver.getAnchors({ orgId: ORG, query: "voice" });

    expect(hits).toHaveLength(1);
    expect(db).toHaveBeenCalledWith(
      expect.stringContaining("from noelle.vaults"),
      [ORG],
    );
    expect(nella.searchContext).toHaveBeenCalledWith({
      workspace: "mars-demooperator",
      query: "voice",
      topK: 8,
    });
  });

  it("returns an empty array when no vault row exists", async () => {
    const db = vi.fn(async () => []);
    const nella = stubNella();
    const resolver = createVaultResolver({ db, nella });

    const hits = await resolver.getAnchors({ orgId: ORG, query: "voice" });
    expect(hits).toEqual([]);
    expect(nella.searchContext).not.toHaveBeenCalled();
  });

  it("degrades gracefully when Nella throws", async () => {
    const db = vi.fn(async () => [
      { nella_workspace_id: "mars-demooperator", status: "active" },
    ]);
    const nella: NellaClient = {
      searchContext: vi.fn(async () => {
        throw new Error("nella 500");
      }),
      getAnchors: vi.fn(async () => []),
      ready: vi.fn(async () => false),
    };
    const resolver = createVaultResolver({ db, nella });

    const hits = await resolver.getAnchors({ orgId: ORG, query: "voice" });
    expect(hits).toEqual([]);
  });

  it("skips the Nella call when vault status is not active", async () => {
    const db = vi.fn(async () => [
      { nella_workspace_id: "mars-demooperator", status: "paused" },
    ]);
    const nella = stubNella([makeHit("p")]);
    const resolver = createVaultResolver({ db, nella });

    const hits = await resolver.getAnchors({ orgId: ORG, query: "voice" });
    expect(hits).toEqual([]);
    expect(nella.searchContext).not.toHaveBeenCalled();
  });

  it("caches the workspace lookup within a resolver instance", async () => {
    const db = vi.fn(async () => [
      { nella_workspace_id: "mars-demooperator", status: "active" },
    ]);
    const nella = stubNella();
    const resolver = createVaultResolver({ db, nella });

    await resolver.getAnchors({ orgId: ORG, query: "a" });
    await resolver.getAnchors({ orgId: ORG, query: "b" });

    expect(db).toHaveBeenCalledTimes(1);
  });

  it("threads custom topK and filePattern filters through to Nella", async () => {
    const db = vi.fn(async () => [
      { nella_workspace_id: "mars-demooperator", status: "active" },
    ]);
    const nella = stubNella();
    const resolver = createVaultResolver({ db, nella });

    await resolver.getAnchors({
      orgId: ORG,
      query: "q",
      topK: 3,
      filters: { filePattern: "vault/posts/**" },
    });

    expect(nella.searchContext).toHaveBeenCalledWith({
      workspace: "mars-demooperator",
      query: "q",
      topK: 3,
      filters: { filePattern: "vault/posts/**" },
    });
  });

  it("exposes resolve() as a public lookup primitive", async () => {
    const db = vi.fn(async () => [
      { nella_workspace_id: "mars-acme", status: "active" },
    ]);
    const resolver = createVaultResolver({ db, nella: stubNella() });

    const lookup = await resolver.resolve(ORG);
    expect(lookup).toEqual({
      nella_workspace_id: "mars-acme",
      status: "active",
    });
  });
});
