import { expect, it, vi } from "vitest";
import { createGcsNellaClient, type GcsStorageReader } from "./gcsAnchorSource.js";

const search = { workspace: "mars-fixture", query: "shipping" };
function source(bodies: Buffer[], download?: (index: number) => Promise<Buffer[]>): GcsStorageReader {
  return { bucket: () => ({ getFiles: async ({ prefix }) => [bodies.map((body, index) => ({
    name: `${prefix}${index}.md`, metadata: {},
    download: () => download ? download(index) : Promise.resolve([body]),
  }))] }) };
}
function held() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}

it("coalesces overlapping complete workspace loads", async () => {
  const gate = held();
  const download = vi.fn(async () => { await gate.promise; return [Buffer.from("shipping")]; });
  const client = createGcsNellaClient({ bucket: "fixture", storage: source([Buffer.alloc(0)], download) });
  const pending = [client.searchContext(search), client.searchContext(search)];
  try {
    await vi.waitFor(() => expect(download).toHaveBeenCalled());
    expect(download).toHaveBeenCalledTimes(1);
  } finally { gate.release(); await Promise.all(pending); }
});
it("bounds concurrent workspace downloads to four", async () => {
  let active = 0, peak = 0;
  const download = async () => {
    peak = Math.max(peak, ++active);
    await new Promise(resolve => setTimeout(resolve, 10));
    active--; return [Buffer.from("shipping")];
  };
  const client = createGcsNellaClient({ bucket: "fixture", storage: source(Array(12).fill(Buffer.alloc(0)), download) });
  expect(await client.searchContext(search)).toHaveLength(8);
  expect(peak).toBeLessThanOrEqual(4); expect(active).toBe(0);
});
it("rejects an oversized complete corpus before starting downloads", async () => {
  const download = vi.fn(async () => [Buffer.from("shipping")]);
  const client = createGcsNellaClient({ bucket: "fixture", storage: source(Array(201).fill(Buffer.alloc(0)), download) });
  await expect(client.searchContext(search)).rejects.toThrow(/limit|large|capacity/);
  expect(download).not.toHaveBeenCalled();
});
it("rejects an oversized complete file rather than indexing a partial body", async () => {
  const client = createGcsNellaClient({ bucket: "fixture", storage: source([Buffer.from("shipping " + "a".repeat(200_000))]) });
  await expect(client.searchContext(search)).rejects.toThrow(/limit|large/);
});
it("rejects an oversized aggregate corpus rather than silently omitting files", async () => {
  const client = createGcsNellaClient({ bucket: "fixture", storage: source(Array(22).fill(Buffer.from("shipping " + "a".repeat(199_990)))) });
  await expect(client.searchContext(search)).rejects.toThrow(/limit|large/);
});
it("does not index malformed UTF-8 as repaired source text", async () => {
  const client = createGcsNellaClient({ bucket: "fixture", storage: source([Buffer.from([115,104,105,112,112,105,110,103,32,255])]) });
  await expect(client.searchContext(search)).rejects.toThrow(/UTF|encoding/);
});
it("evicts the least recently used completed workspace after thirty-two entries", async () => {
  const getFiles = vi.fn(async () => [[]] as [never[]]);
  const client = createGcsNellaClient({ bucket: "fixture", storage: { bucket: () => ({ getFiles }) } });
  for (let index = 0; index < 33; index++) await client.searchContext({ ...search, workspace: `mars-fixture${index}` });
  await client.searchContext({ ...search, workspace: "mars-fixture0" });
  expect(getFiles).toHaveBeenCalledTimes(34);
});
it("awaits every started download before reporting failure", async () => {
  const gate = held(); let finished = false;
  const download = vi.fn(async (index: number) => {
    if (index === 0) throw new Error("download unavailable");
    await gate.promise; return [Buffer.from("shipping")];
  });
  const client = createGcsNellaClient({ bucket: "fixture", storage: source(Array(4).fill(Buffer.alloc(0)), download) });
  const pending = client.searchContext(search).catch(error => error).finally(() => { finished = true; });
  try {
    await vi.waitFor(() => expect(download).toHaveBeenCalledTimes(4));
    expect(finished).toBe(false);
  } finally { gate.release(); await pending; }
  expect(await pending).toMatchObject({ message: "download unavailable" });
});
it("keeps a complete healthy corpus searchable", async () => {
  const client = createGcsNellaClient({ bucket: "fixture", storage: source([Buffer.from("shipping healthy")]) });
  const hits = await client.searchContext(search);
  expect(hits).toHaveLength(1); expect(hits[0]?.filePath).toBe("0.md");
});
it("uses the current resolved prefix before a completed cache entry", async () => {
  let prefix = "first/";
  const storage: GcsStorageReader = { bucket: () => ({ getFiles: async args => [[{
    name: `${args.prefix}a.md`, metadata: {}, download: async () => [Buffer.from(`shipping ${args.prefix}`)],
  }]] }) };
  const client = createGcsNellaClient({ bucket: "fixture", storage, workspaceToPrefix: () => prefix });
  expect((await client.searchContext(search))[0]?.snippet).toContain("first/"); prefix = "second/";
  expect((await client.searchContext(search))[0]?.snippet).toContain("second/");
});
it("rejects repeated metadata cursors before downloading a partial corpus", async () => {
  const getFiles = vi.fn(async () => [[], { pageToken: "repeat" }] as [never[], { pageToken: string }]);
  const client = createGcsNellaClient({ bucket: "fixture", storage: { bucket: () => ({ getFiles }) } });
  await expect(client.searchContext(search)).rejects.toThrow(/continuation/); expect(getFiles).toHaveBeenCalledTimes(2);
});
it("rejects an incomplete empty-page traversal at the page limit", async () => {
  let pages = 0;
  const getFiles = vi.fn(async () => [[], { pageToken: `page${++pages}` }] as [never[], { pageToken: string }]);
  const client = createGcsNellaClient({ bucket: "fixture", storage: { bucket: () => ({ getFiles }) } });
  await expect(client.searchContext(search)).rejects.toThrow(/page limit/); expect(pages).toBe(10);
});
it("rejects a corpus with too many heading chunks", async () => {
  const client = createGcsNellaClient({ bucket: "fixture", storage: source([Buffer.from("## shipping\n\n".repeat(2001))]) });
  await expect(client.searchContext(search)).rejects.toThrow(/chunk limit/);
});
it("keeps recently used completed entries when evicting a full cache", async () => {
  const getFiles = vi.fn(async () => [[]] as [never[]]);
  const client = createGcsNellaClient({ bucket: "fixture", storage: { bucket: () => ({ getFiles }) } });
  for (let index = 0; index < 32; index++) await client.searchContext({ ...search, workspace: `mars-fixture${index}` });
  await client.searchContext({ ...search, workspace: "mars-fixture0" });
  await client.searchContext({ ...search, workspace: "mars-fixture32" });
  await client.searchContext({ ...search, workspace: "mars-fixture0" });
  expect(getFiles).toHaveBeenCalledTimes(33);
  await client.searchContext({ ...search, workspace: "mars-fixture1" });
  expect(getFiles).toHaveBeenCalledTimes(34);
});
it.each(["", "/", "../foreign/", "fixture/../foreign/", "fixture\0/"])("rejects unsafe corpus prefix %j before listing", async prefix => {
  const getFiles = vi.fn(async () => [[]] as [never[]]);
  const client = createGcsNellaClient({ bucket: "fixture", storage: { bucket: () => ({ getFiles }) }, workspaceToPrefix: () => prefix });
  await expect(client.searchContext(search)).rejects.toThrow(/prefix/); expect(getFiles).not.toHaveBeenCalled();
});
