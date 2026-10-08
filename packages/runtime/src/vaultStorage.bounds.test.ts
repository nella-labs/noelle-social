import { expect, it, vi } from "vitest";
import { createVaultStorage, type StorageDeps } from "./vaultStorage.js";

function fixture(metadata: Record<string, unknown> = { size: "8", updated: "2026-10-06T00:00:00Z" }) {
  const download = vi.fn(async () => [Buffer.from("shipping")]);
  const save = vi.fn(async () => undefined);
  const getFiles = vi.fn(async () => [[{ name: "fixture/a.md", metadata }]]);
  const file = { download, save, delete: vi.fn(), getSignedUrl: vi.fn(async () => ["https://fixture.invalid/signed"]) };
  const deps = { bucket: () => ({ getFiles, file: vi.fn(() => file) }) } as unknown as StorageDeps;
  return { storage: createVaultStorage(deps), getFiles, download, save, file };
}
const scope = { bucket: "fixture", prefix: "fixture/" };

it("holds missing metadata instead of inventing a measured zero-byte epoch file", async () => {
  await expect(fixture({}).storage.list(scope)).rejects.toThrow(/metadata/);
});
it("rejects malformed UTF-8 rather than repairing a vault source", async () => {
  const f = fixture(); f.download.mockResolvedValue([Buffer.from([115,104,105,112,112,105,110,103,255])]);
  await expect(f.storage.readText({ ...scope, filename: "a.md" })).rejects.toThrow(/UTF|encoding/);
});
it("holds an oversized complete preview instead of reading unbounded source bytes", async () => {
  const f = fixture(); f.download.mockResolvedValue([Buffer.alloc(4 * 1024 * 1024 + 1)]);
  await expect(f.storage.readText({ ...scope, filename: "a.md" })).rejects.toThrow(/large|limit/);
});
it("rejects invalid UTF-16 text before dispatching a repaired upload", async () => {
  const f = fixture();
  await expect(f.storage.writeText({ ...scope, filename: "a.md", body: "shipping\ud800" })).rejects.toThrow(/encoding/);
  expect(f.save).not.toHaveBeenCalled();
});
it.each(["", "/", "/foreign/"])("rejects root or absolute tenant prefix %j before listing", async prefix => {
  const f = fixture(); await expect(f.storage.list({ ...scope, prefix })).rejects.toThrow(/prefix/);
  expect(f.getFiles).not.toHaveBeenCalled();
});
it("keeps complete scoped metadata and valid UTF8 preview healthy", async () => {
  const f = fixture();
  expect(await f.storage.list(scope)).toEqual([{ path: "fixture/a.md", size: 8, updatedISO: "2026-10-06T00:00:00Z" }]);
  expect(await f.storage.readText({ ...scope, filename: "a.md" })).toBe("shipping");
});
it.each([0, -1, 1.5, NaN, Infinity, 604801])("rejects invalid signed lifetime %s before signing", async ttlSeconds => {
  const f = fixture();
  await expect(f.storage.signUpload({ ...scope, filename: "a.md", contentType: "text/markdown", ttlSeconds }))
    .rejects.toThrow(RangeError);
  expect(f.file.getSignedUrl).not.toHaveBeenCalled();
});
it("accepts the seven-day signed lifetime boundary", async () => {
  const f = fixture();
  expect(await f.storage.signUpload({ ...scope, filename: "a.md", contentType: "text/markdown", ttlSeconds: 604800 }))
    .toBe("https://fixture.invalid/signed");
  expect(f.file.getSignedUrl).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
    version: "v4", action: "write", contentType: "text/markdown", expires: expect.any(Number),
  }));
});
