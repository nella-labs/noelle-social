import { describe, it, expect } from "vitest";
import type { VaultFileMeta } from "@noelle/runtime/vault-storage";
import { buildVaultTree, vaultStats } from "./vault-tree";

const meta = (path: string, size = 100): VaultFileMeta => ({
  path,
  size,
  updatedISO: "2026-05-25T00:00:00Z",
});

describe("buildVaultTree", () => {
  it("nests flat GCS paths into folders, stripping the prefix", () => {
    const tree = buildVaultTree(
      [meta("operator/01-business/company.md"), meta("operator/01-business/positioning.md"), meta("operator/voice.md")],
      "operator/",
    );
    const folder = tree.find((n) => n.type === "folder");
    const topFile = tree.find((n) => n.type === "file");
    expect(folder).toMatchObject({ type: "folder", name: "01-business", path: "01-business" });
    expect(folder && folder.type === "folder" ? folder.children.map((c) => c.name).sort() : []).toEqual([
      "company.md",
      "positioning.md",
    ]);
    expect(topFile).toMatchObject({ type: "file", name: "voice.md", path: "voice.md" });
  });

  it("maps updatedISO onto lastModifiedISO and defaults anchoredBy", () => {
    const tree = buildVaultTree([meta("operator/a.md")], "operator/");
    const f = tree[0];
    expect(f && f.type === "file" ? f.lastModifiedISO : null).toBe("2026-05-25T00:00:00Z");
    expect(f && f.type === "file" ? f.anchoredBy : null).toEqual([]);
  });

  it("ignores objects that are exactly the prefix or end with /", () => {
    const tree = buildVaultTree([meta("operator/"), meta("operator/a.md")], "operator/");
    expect(tree).toHaveLength(1);
    expect(tree[0]?.type).toBe("file");
  });

  it("returns [] for an empty listing", () => {
    expect(buildVaultTree([], "operator/")).toEqual([]);
  });
});

describe("buildVaultTree (cont.)", () => {
  it("never sets wordCount on live GCS files (spec: omit in v1)", () => {
    const tree = buildVaultTree([meta("operator/a.md")], "operator/");
    const f = tree[0];
    expect(f && f.type === "file" ? f.wordCount : "x").toBeUndefined();
    expect(f && f.type === "file" ? f.body : "x").toBeUndefined();
  });
});

describe("vaultStats", () => {
  it("counts unique folders, files, and total bytes (prefix stripped)", () => {
    const stats = vaultStats(
      [
        meta("operator/01-business/company.md", 10),
        meta("operator/01-business/positioning.md", 20),
        meta("operator/voice.md", 5),
      ],
      "operator/",
    );
    expect(stats).toEqual({ folders: 1, files: 3, bytes: 35 });
  });

  it("ignores the prefix-only placeholder object", () => {
    const stats = vaultStats([meta("operator/"), meta("operator/a.md", 7)], "operator/");
    expect(stats).toEqual({ folders: 0, files: 1, bytes: 7 });
  });

  it("agrees with buildVaultTree on a multi-segment prefix", () => {
    const files = [
      meta("orgs/acme/docs/readme.md"),
      meta("orgs/acme/docs/guide.md"),
      meta("orgs/acme/top.md"),
    ];
    const prefix = "orgs/acme/";
    const tree = buildVaultTree(files, prefix);
    const stats = vaultStats(files, prefix);
    const leafCount = (function count(nodes: typeof tree): number {
      return nodes.reduce(
        (n, node) => n + (node.type === "file" ? 1 : count(node.children)),
        0,
      );
    })(tree);
    // Same logical file set → counts must match (regression guard for the
    // prefix-strip mismatch the reviewer caught).
    expect(stats.files).toBe(leafCount);
    expect(stats.files).toBe(3);
    expect(stats.folders).toBe(1); // "docs"
  });
});
