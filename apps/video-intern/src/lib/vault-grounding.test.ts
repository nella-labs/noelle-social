import { describe, expect, it } from "vitest";
import { loadBrandContext, type VaultKb } from "./vault-grounding.js";

const kbReturning = (snippets: string[]): VaultKb => ({
  async search() {
    return snippets.map((s) => ({ snippet: s, score: 1, highlights: [], source: { filePath: "x.md", startLine: 1, endLine: 2 } }));
  },
});

describe("loadBrandContext", () => {
  it("returns [] when there is no KB (no vault configured)", async () => {
    await expect(loadBrandContext(null, "grow")).resolves.toEqual([]);
  });

  it("maps KB hits to snippet strings", async () => {
    await expect(loadBrandContext(kbReturning(["a", "b"]), "grow")).resolves.toEqual(["a", "b"]);
  });

  it("fails open to [] when the KB search throws", async () => {
    const kb: VaultKb = { async search() { throw new Error("index error"); } };
    await expect(loadBrandContext(kb, "grow")).resolves.toEqual([]);
  });

  it("falls back to a generic brand probe for an empty query", async () => {
    let seen = "";
    const kb: VaultKb = {
      async search(q) {
        seen = q;
        return [];
      },
    };
    await loadBrandContext(kb, "   ");
    expect(seen).not.toBe("");
  });
});
