import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildChunkIndex } from "./bm25Index.js";
import { buildDenseIndex } from "./denseChunkIndex.js";
import { createGcsNellaClient, type GcsStorageReader } from "./gcsAnchorSource.js";
import { createLocalFsKnowledgeBase, knowledgeBaseFromNella } from "./knowledgeBase.js";
import { createNellaClient, type Hit } from "./nellaClient.js";
import { voyageTopK } from "./voyageResponse.js";

const invalid = [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1];
const body = "Shipping daily with concrete milestones.";
const hit: Hit = { path: "voice/sample.md", filePath: "voice/sample.md", snippet: body, score: 1, startLine: 1, endLine: 1, highlights: ["shipping"] };
function cloud() {
  const download = vi.fn(async () => [Buffer.from(body)]);
  const getFiles = vi.fn<ReturnType<GcsStorageReader["bucket"]>["getFiles"]>(async () => [[{ name: "demooperator/voice/sample.md", metadata: {}, download }]]);
  const storage: GcsStorageReader = { bucket: () => ({ getFiles }) };
  return { getFiles, download, client: createGcsNellaClient({ bucket: "fixture", storage }) };
}
function hosted() {
  const fetchImpl = vi.fn(async () => Response.json({ data: { results: [
    { chunk: { filePath: hit.filePath, content: body, startLine: 1, endLine: 1 }, score: 1 },
  ] } }));
  return { fetchImpl, client: createNellaClient({ apiKey: "synthetic", fetchImpl }) };
}

describe("retrieval request admission", () => {
  let dir: string;
  beforeAll(async () => { dir = await mkdtemp(join(tmpdir(), "noelle-retrieval-")); await writeFile(join(dir, "sample.md"), body); });
  afterAll(async () => { await rm(dir, { recursive: true, force: true }); });

  it("keeps valid lexical, dense and provider limits", () => {
    const chunks = [{ filePath: "sample.md", body, headingPath: [], startLine: 1, endLine: 1 }];
    expect(buildChunkIndex(chunks).search("shipping", 1)).toHaveLength(1);
    expect(buildDenseIndex([[1, 0]]).search([1, 0], 1)).toHaveLength(1);
    expect(voyageTopK(1, 1)).toBe(1);
  });
  it("keeps valid hosted retrieval and the original source reference", async () => {
    const { client, fetchImpl } = hosted();
    expect(await client.searchContext({ workspace: "mars-demooperator", query: "shipping", topK: 1 })).toMatchObject([{ filePath: "voice/sample.md" }]);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });
  it("keeps valid local and adapted knowledge retrieval", async () => {
    const local = createLocalFsKnowledgeBase({ dir, watch: false });
    try { expect(await local.search("shipping", 1)).toHaveLength(1); }
    finally { local.close?.(); }
    const searchContext = vi.fn(async () => [hit]);
    expect(await knowledgeBaseFromNella({ searchContext }, "mars-demooperator").search("shipping", 1)).toHaveLength(1);
    expect(searchContext).toHaveBeenCalledOnce();
  });

  it.each(["", " \t\n"])("blank workspace %j disables GCS and HTTP retrieval", async workspace => {
    const gcs = cloud();
    const http = hosted();
    for (const client of [gcs.client, http.client]) {
      const kb = knowledgeBaseFromNella(client, workspace);
      expect(await kb.ready()).toBe(false);
      expect(await kb.search("shipping", 1, { filterDirs: ["voice"] })).toEqual([]);
    }
    expect(gcs.getFiles).not.toHaveBeenCalled();
    expect(gcs.download).not.toHaveBeenCalled();
    expect(http.fetchImpl).not.toHaveBeenCalled();
  });

  it.each(invalid)("lexical and dense indexes reject invalid limit %j", limit => {
    const chunks = [{ filePath: "sample.md", body, headingPath: [], startLine: 1, endLine: 1 }];
    expect(buildChunkIndex(chunks).search("shipping", limit)).toEqual([]);
    expect(buildDenseIndex([[1, 0]]).search([1, 0], limit)).toEqual([]);
    expect(voyageTopK(1, limit)).toBe(0);
  });
  it.each(invalid)("cloud search and anchors reject limit %j before storage access", async limit => {
    const { client, getFiles, download } = cloud();
    expect(await client.searchContext({ workspace: "mars-demooperator", query: "shipping", topK: limit })).toEqual([]);
    expect(await client.getAnchors({ workspace: "mars-demooperator", handle: "demooperator", limit })).toEqual([]);
    expect(getFiles).not.toHaveBeenCalled(); expect(download).not.toHaveBeenCalled();
  });
  it.each(invalid)("hosted search and anchors reject limit %j before network dispatch", async limit => {
    const { client, fetchImpl } = hosted();
    expect(await client.searchContext({ workspace: "mars-demooperator", query: "shipping", topK: limit })).toEqual([]);
    expect(await client.getAnchors({ workspace: "mars-demooperator", handle: "demooperator", limit })).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it.each(invalid)("local and adapted knowledge bases reject limit %j before backend access", async limit => {
    const local = createLocalFsKnowledgeBase({ dir, watch: false });
    try { expect(await local.search("shipping", limit)).toEqual([]); }
    finally { local.close?.(); }
    const searchContext = vi.fn(async () => [hit]);
    expect(await knowledgeBaseFromNella({ searchContext }, "mars-demooperator").search("shipping", limit)).toEqual([]);
    expect(searchContext).not.toHaveBeenCalled();
  });
  it("keeps valid retrieval and exact vault-relative source references", async () => {
    const { client } = cloud();
    const kb = knowledgeBaseFromNella(client, "mars-demooperator");
    expect(await kb.search("shipping", 1, { filterDirs: ["voice"] })).toMatchObject([
      { source: { filePath: "voice/sample.md", startLine: 1, endLine: 1 } },
    ]);
    expect(await client.getAnchors({ workspace: "mars-demooperator", handle: "demooperator", limit: 1 })).toMatchObject([{ path: "voice/sample.md" }]);
    const { client: http, fetchImpl } = hosted();
    expect(await http.searchContext({ workspace: "mars-demooperator", query: "shipping", topK: 1 })).toHaveLength(1);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });
  it("rejects an out-of-prefix cloud object before downloading or indexing it", async () => {
    const foreign = vi.fn(async () => [Buffer.from(body)]);
    const client = createGcsNellaClient({ bucket: "fixture", storage: { bucket: () => ({
      getFiles: async () => [[{ name: "foreign/voice/sample.md", metadata: {}, download: foreign }]],
    }) } });
    expect(await client.searchContext({ workspace: "mars-demooperator", query: "shipping" })).toEqual([]);
    expect(foreign).not.toHaveBeenCalled();
  });
});
