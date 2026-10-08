import { describe, it, expect, vi } from "vitest";
import { createGcsNellaClient, type GcsStorageReader } from "./gcsAnchorSource.js";

function reader(files: Record<string, string>): GcsStorageReader {
  return {
    bucket(_bucketName: string) {
      return {
        async getFiles({ prefix }: { prefix?: string }) {
          const filtered = Object.keys(files)
            .filter((name) => !prefix || name.startsWith(prefix))
            .map((name) => ({
              name,
              metadata: { updated: "2026-05-26T00:00:00Z" },
              async download(): Promise<Buffer[]> {
                return [Buffer.from(files[name] ?? "", "utf8")];
              },
            }));
          return [filtered] as [typeof filtered];
        },
      };
    },
  };
}

describe("gcsAnchorSource (NellaClient over GCS)", () => {
  it("returns hits ranked by query-token overlap", async () => {
    const client = createGcsNellaClient({
      bucket: "noelle-vaults",
      storage: reader({
        "demooperator/posts/a.md": "Shipping daily is the only way to win.",
        "demooperator/posts/b.md": "Talking about marketing strategy.",
        "demooperator/posts/c.md": "Daily shipping shipping shipping. Win win.",
      }),
    });

    const hits = await client.searchContext({
      workspace: "mars-demooperator",
      query: "shipping daily",
      topK: 3,
    });

    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]?.filePath.endsWith(".md")).toBe(true);
    // c.md mentions both tokens more — should beat a.md.
    expect(hits[0]?.filePath).toBe("posts/c.md");
    expect(hits.map((h) => h.filePath)).toContain("posts/a.md");
    expect(hits.map((h) => h.filePath)).not.toContain("posts/b.md");
  });

  it("workspace name mars-<slug> resolves to prefix <slug>/", async () => {
    const storage = reader({
      "demooperator/posts/x.md": "Shipping daily.",
      "acme/posts/y.md": "Shipping daily.",
    });
    const client = createGcsNellaClient({ bucket: "noelle-vaults", storage });

    const demooperator = await client.searchContext({ workspace: "mars-demooperator", query: "shipping" });
    const acme = await client.searchContext({ workspace: "mars-acme", query: "shipping" });

    expect(demooperator.map((h) => h.filePath)).toEqual(["posts/x.md"]);
    expect(acme.map((h) => h.filePath)).toEqual(["posts/y.md"]);
  });

  it("returns the first 240 chars as a snippet when no token highlighted", async () => {
    const longBody = "lorem ipsum ".repeat(40);
    const client = createGcsNellaClient({
      bucket: "noelle-vaults",
      storage: reader({ "demooperator/x.md": longBody }),
    });
    const [hit] = await client.searchContext({ workspace: "mars-demooperator", query: "lorem" });
    expect(hit?.snippet.length).toBeLessThanOrEqual(240);
    expect(hit?.snippet).toMatch(/lorem/);
  });

  it("caches per-workspace file list between calls", async () => {
    const getFiles = vi.fn(async () => [[]] as Awaited<ReturnType<ReturnType<GcsStorageReader["bucket"]>["getFiles"]>>);
    const storage: GcsStorageReader = {
      bucket() {
        return { getFiles };
      },
    };
    const client = createGcsNellaClient({ bucket: "noelle-vaults", storage });
    await client.searchContext({ workspace: "mars-demooperator", query: "shipping" });
    await client.searchContext({ workspace: "mars-demooperator", query: "marketing" });
    expect(getFiles).toHaveBeenCalledTimes(1);
  });

  it("respects topK", async () => {
    const files = Object.fromEntries(
      Array.from({ length: 12 }, (_, i) => [`demooperator/p${i}.md`, "shipping daily wins"]),
    );
    const client = createGcsNellaClient({
      bucket: "noelle-vaults",
      storage: reader(files),
    });
    const hits = await client.searchContext({
      workspace: "mars-demooperator",
      query: "shipping",
      topK: 5,
    });
    expect(hits).toHaveLength(5);
  });

  it("filterDirs scopes hits to matching filePath prefixes only", async () => {
    const client = createGcsNellaClient({
      bucket: "noelle-vaults",
      storage: reader({
        "demooperator/02-brand/voice.md": "Shipping daily wins the voice playbook.",
        "demooperator/01-business/x.md": "Shipping daily wins the revenue model.",
      }),
    });
    const hits = await client.searchContext({
      workspace: "mars-demooperator",
      query: "shipping daily wins",
      topK: 5,
      filterDirs: ["02-brand"],
    });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.every((h) => h.filePath.startsWith("02-brand/"))).toBe(true);
    expect(hits.map((h) => h.filePath)).not.toContain("01-business/x.md");
  });

  it("filters the candidate pool BEFORE slicing to topK (scoped search still fills topK)", async () => {
    // 6 noise files rank ahead by raw match count, then 3 allowed files.
    // A naive topK=3 fetch would return only noise and zero allowed hits;
    // widen-then-filter must still surface the allowed dir's hits.
    const files: Record<string, string> = {};
    for (let i = 0; i < 6; i++) {
      files[`demooperator/noise/n${i}.md`] = "shipping shipping shipping daily daily wins wins";
    }
    for (let i = 0; i < 3; i++) {
      files[`demooperator/brand/b${i}.md`] = "shipping daily wins";
    }
    const client = createGcsNellaClient({ bucket: "noelle-vaults", storage: reader(files) });
    const hits = await client.searchContext({
      workspace: "mars-demooperator",
      query: "shipping daily wins",
      topK: 3,
      filterDirs: ["brand"],
    });
    expect(hits).toHaveLength(3);
    expect(hits.every((h) => h.filePath.startsWith("brand/"))).toBe(true);
  });

  it("empty filterDirs array behaves identically to no filter", async () => {
    const storage = reader({
      "demooperator/02-brand/voice.md": "shipping daily wins",
      "demooperator/01-business/x.md": "shipping daily wins",
    });
    const client = createGcsNellaClient({ bucket: "noelle-vaults", storage });
    const base = await client.searchContext({ workspace: "mars-demooperator", query: "shipping daily wins", topK: 5 });
    const empty = await client.searchContext({ workspace: "mars-demooperator", query: "shipping daily wins", topK: 5, filterDirs: [] });
    expect(empty.map((h) => h.filePath)).toEqual(base.map((h) => h.filePath));
    expect(base.length).toBeGreaterThanOrEqual(2);
  });

  it("ready() returns true when storage is reachable", async () => {
    const client = createGcsNellaClient({
      bucket: "noelle-vaults",
      storage: reader({}),
    });
    expect(await client.ready()).toBe(true);
  });

  it("returns empty array when no markdown matches the query", async () => {
    const client = createGcsNellaClient({
      bucket: "noelle-vaults",
      storage: reader({ "demooperator/x.md": "nothing to see here" }),
    });
    const hits = await client.searchContext({
      workspace: "mars-demooperator",
      query: "kubernetes",
    });
    expect(hits).toEqual([]);
  });

  it("ignores non-markdown files in the prefix", async () => {
    const client = createGcsNellaClient({
      bucket: "noelle-vaults",
      storage: reader({
        "demooperator/notes.md": "shipping daily wins",
        "demooperator/binary.png": "shipping daily wins (but binary)",
        "demooperator/data.json": "{ shipping: daily }",
      }),
    });
    const hits = await client.searchContext({
      workspace: "mars-demooperator",
      query: "shipping",
    });
    expect(hits.map((h) => h.filePath)).toEqual(["notes.md"]);
  });

  it("returns chunk-level hits with real startLine/endLine, not 1/1", async () => {
    const body = [
      "---", // line 1
      "type: voice", // line 2
      "---", // line 3
      "", // line 4
      "# Voice", // line 5
      "Intro paragraph.", // line 6
