import { afterEach, expect, it, vi } from "vitest";
import { createVaultListing, type VaultListingDeps } from "./vaultListing.js";

afterEach(() => vi.restoreAllMocks());
const scope = { bucket: "fixture", prefix: "tenant/" };
const file = (path: string) => ({ name: path, metadata: { size: "8", updated: "2026-10-06T00:00:00Z" } });
function fixture(pages: unknown[][]) {
  const getFiles = vi.fn(async () => pages.shift());
  return { getFiles, owner: createVaultListing({ bucket: () => ({ getFiles }) } as unknown as VaultListingDeps) };
}

it("reads only the requested management page and preserves continuation", async () => {
  const f = fixture([[[file("tenant/b.md")], { pageToken: "next" }]]);
  expect(await f.owner.listPage({ ...scope, pageToken: "first", limit: 1 })).toEqual({
    files: [{ path: "tenant/b.md", size: 8, updatedISO: "2026-10-06T00:00:00Z" }], nextPageToken: "next",
  });
  expect(f.getFiles).toHaveBeenCalledExactlyOnceWith({ prefix: "tenant/", autoPaginate: false, maxResults: 1, pageToken: "first" });
});

it("finishes all bounded mirror pages before returning a complete result", async () => {
  const f = fixture([[[file("tenant/a.md")], { pageToken: "next" }], [[file("tenant/b.md")]]]);
  expect((await f.owner.list(scope)).map(row => row.path)).toEqual(["tenant/a.md", "tenant/b.md"]);
  expect(f.getFiles).toHaveBeenNthCalledWith(2, expect.objectContaining({ pageToken: "next", autoPaginate: false, maxResults: 100 }));
});

it.each([0, 101, 1.5, NaN])("rejects page limit %s before storage", async limit => {
  const f = fixture([]); await expect(f.owner.listPage({ ...scope, limit })).rejects.toThrow(RangeError);
  expect(f.getFiles).not.toHaveBeenCalled();
});
it("rejects a malformed or oversized input cursor before storage", async () => {
  const f = fixture([]);
  for (const pageToken of ["", "x".repeat(2049), 1]) {
    await expect(f.owner.listPage({ ...scope, pageToken: pageToken as string })).rejects.toThrow(RangeError);
  }
  expect(f.getFiles).not.toHaveBeenCalled();
});

it("holds a repeated continuation without exposing a partial mirror listing", async () => {
  const f = fixture([[[file("tenant/a.md")], { pageToken: "next" }], [[], { pageToken: "next" }]]);
  await expect(f.owner.list(scope)).rejects.toThrow(/continuation/); expect(f.getFiles).toHaveBeenCalledTimes(2);
});
it("holds duplicate source identities across pages", async () => {
  const f = fixture([[[file("tenant/a.md")], { pageToken: "next" }], [[file("tenant/a.md")]]]);
  await expect(f.owner.list(scope)).rejects.toThrow(/Duplicate/);
});
it("accepts a complete tenth page but holds unfinished listing at that limit", async () => {
  const pages = () => Array.from({ length: 10 }, (_, i) => [[file(`tenant/${i}.md`)], ...(i === 9 ? [] : [{ pageToken: String(i) }])]);
  expect(await fixture(pages()).owner.list(scope)).toHaveLength(10);
  const unfinished = pages(); unfinished[9]!.push({ pageToken: "more" });
  const f = fixture(unfinished); await expect(f.owner.list(scope)).rejects.toThrow(/page limit/);
  expect(f.getFiles).toHaveBeenCalledTimes(10);
});
it("uses the original complete-list deadline across pages", async () => {
  let now = 0; vi.spyOn(performance, "now").mockImplementation(() => now);
  const getFiles = vi.fn(async () => { now += 20_000; return [[], { pageToken: String(now) }]; });
  const owner = createVaultListing({ bucket: () => ({ getFiles }) } as unknown as VaultListingDeps);
  await expect(owner.list(scope)).rejects.toThrow(/timeout/);
  expect(getFiles).toHaveBeenNthCalledWith(1, expect.objectContaining({ timeoutMs: 30_000 }));
  expect(getFiles).toHaveBeenNthCalledWith(2, expect.objectContaining({ timeoutMs: 10_000 }));
});
it("rejects foreign, oversize and unknown file metadata instead of fabricating it", async () => {
  for (const entries of [[file("foreign/a.md")], [file("tenant/a.md"), file("tenant/b.md")],
    [{ name: "tenant/a.md", metadata: {} }]]) {
    await expect(fixture([[entries]]).owner.listPage({ ...scope, limit: 1 })).rejects.toThrow(/metadata/);
  }
});
