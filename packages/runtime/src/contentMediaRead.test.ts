import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, writeFile, truncate, rm } from "node:fs/promises";
import { appendFileSync } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONTENT_MEDIA_MAX_BYTES } from "@noelle/contracts";
import { readContentMedia, readLocalContentMedia } from "./contentMediaRead.js";

const owned = vi.hoisted(() => ({ handles: [] as FileHandle[] }));
vi.mock("node:fs/promises", async importOriginal => {
  const original = await importOriginal<typeof import("node:fs/promises")>();
  return { ...original, open: vi.fn(async (...args: Parameters<typeof original.open>) => {
    const handle = await original.open(...args); owned.handles.push(handle);
    vi.spyOn(handle, "createReadStream"); return handle;
  }) };
});
const dirs: string[] = [];
afterEach(async () => {
  vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks();
  for (const handle of owned.handles.splice(0)) {
    await expect(handle.stat()).rejects.toMatchObject({ code: "EBADF" });
  }
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});
async function fixture(size = 4) {
  const dir = await mkdtemp(join(tmpdir(), "noelle-content-read-")); dirs.push(dir);
  const path = join(dir, "asset.png"); await writeFile(path, new Uint8Array([1, 2, 3, 4]));
  await truncate(path, size); return { dir, path };
}
describe("bounded content media reads", () => {
  it("reads an existing regular file and closes its actual descriptor", async () => {
    const { dir } = await fixture();
    expect(await readLocalContentMedia(dir, "asset.png")).toEqual(new Uint8Array([1, 2, 3, 4]));
  });
  it("retains the maximum decoded upload size", async () => {
    const { dir } = await fixture(CONTENT_MEDIA_MAX_BYTES);
    expect((await readLocalContentMedia(dir, "asset.png")).length).toBe(11_250_000);
  });
  it("rejects an oversized sparse file before creating a read stream", async () => {
    const { dir } = await fixture(CONTENT_MEDIA_MAX_BYTES + 1);
    await expect(readLocalContentMedia(dir, "asset.png")).rejects.toMatchObject({ code: "body_too_large" });
    expect(owned.handles).toHaveLength(1);
    expect(owned.handles[0]!.createReadStream).not.toHaveBeenCalled();
  });
  it("bounds a file that grows between stat and stream creation", async () => {
    const { dir, path } = await fixture();
    const original = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    const fs = await import("node:fs/promises");
    vi.mocked(fs.open).mockImplementationOnce(async (...args) => {
      const handle = await original.open(...args); owned.handles.push(handle);
      const create = handle.createReadStream.bind(handle);
      handle.createReadStream = options => {
        // Append synchronously before the initial stream starts reading.
        appendFileSync(path, new Uint8Array([5, 6, 7, 8])); return create(options);
      };
      return handle;
    });
    expect(await readLocalContentMedia(dir, "asset.png")).toEqual(new Uint8Array([1, 2, 3, 4]));
  });
  it("rejects a directory and closes its descriptor", async () => {
    const { dir } = await fixture();
    await expect(readLocalContentMedia(dir, ".")).rejects.toThrow("regular file");
  });
  it("refuses a native FIFO without waiting for a writer", async () => {
    const { dir } = await fixture();
    await promisify(execFile)("mkfifo", [join(dir, "pipe")]);
    await expect(readLocalContentMedia(dir, "pipe", { timeoutMs: 100 })).rejects.toThrow("regular file");
  });
  it("never opens storage when the caller is already aborted", async () => {
    const { dir } = await fixture(); const controller = new AbortController(); controller.abort();
    await expect(readLocalContentMedia(dir, "asset.png", { signal: controller.signal })).rejects.toThrow();
    expect(owned.handles).toEqual([]);
  });
  it("falls back to a bounded URL for a missing local file", async () => {
    const { dir } = await fixture(); vi.stubGlobal("fetch", vi.fn(async () => new Response("remote")));
    expect(new TextDecoder().decode((await readContentMedia(dir, { storage_key: "missing", url: "https://media.test/asset" }))!)).toBe("remote");
  });
  it("skips an unsuccessful URL and an empty URL body", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(new Response("denied", { status: 403 }))
      .mockResolvedValueOnce(new Response("")));
    const asset = { storage_key: "asset", url: "https://media.test/asset" };
    expect(await readContentMedia(null, asset)).toBeNull(); expect(await readContentMedia(null, asset)).toBeNull();
  });
  it("cancels and closes the actual HTTP socket after headers stall", async () => {
    let admit!: () => void, close!: () => void;
    const admitted = new Promise<void>(resolve => { admit = resolve; });
    const closed = new Promise<void>(resolve => { close = resolve; });
    const server = createServer((_req, res) => {
      res.writeHead(200); res.write("partial"); res.on("close", close); admit();
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address(); if (!address || typeof address === "string") throw new Error("fixture address");
    try {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      let receive!: () => void;
      const received = new Promise<void>(resolve => { receive = resolve; });
      const nativeFetch = fetch;
      vi.stubGlobal("fetch", async (...args: Parameters<typeof fetch>) => {
        const response = await nativeFetch(...args); receive(); return response;
      });
      const pending = readContentMedia(null, { storage_key: "asset", url: `http://127.0.0.1:${address.port}` }, { timeoutMs: 80 });
      await admitted; await received;
      await vi.advanceTimersByTimeAsync(80);
      expect(await pending).toBeNull();
      await closed;
    } finally {
      vi.useRealTimers();
      server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });
});
