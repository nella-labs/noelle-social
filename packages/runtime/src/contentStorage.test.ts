import { describe, it, expect } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertSafeKey,
  extForMime,
  mediaKey,
  createLocalContentStorage,
  createGcsContentStorage,
} from "./contentStorage.js";

describe("key helpers", () => {
  it("extForMime maps common types and defaults to bin", () => {
    expect(extForMime("image/png")).toBe("png");
    expect(extForMime("image/jpeg")).toBe("jpg");
    expect(extForMime("video/mp4")).toBe("mp4");
    expect(extForMime("application/x-weird")).toBe("bin");
  });

  it("mediaKey is <slug>/media/<id>.<ext> and a hostile slug can't smuggle ..", () => {
    expect(mediaKey("demooperator", "abc", "png")).toBe("demooperator/media/abc.png");
    const k = mediaKey("a/../b", "id", "png");
    expect(k).not.toContain("..");
    expect(k.endsWith("/media/id.png")).toBe(true);
  });

  it("assertSafeKey rejects traversal / absolute keys", () => {
    expect(() => assertSafeKey("../etc/passwd")).toThrow();
    expect(() => assertSafeKey("/abs")).toThrow();
    expect(() => assertSafeKey("a\\b")).toThrow();
    expect(() => assertSafeKey("ok/media/x.png")).not.toThrow();
  });
});

describe("createLocalContentStorage", () => {
  it("writes bytes and returns a /media/<key> url, then deletes", async () => {
    const dir = await mkdtemp(join(tmpdir(), "noelle-media-"));
    const store = createLocalContentStorage({ dir, publicBaseUrl: "http://127.0.0.1:18791/" });
    const key = mediaKey("demooperator", "id1", "png");
    const bytes = new TextEncoder().encode("PNGDATA");

    const { url } = await store.put({ key, bytes, contentType: "image/png" });
    expect(url).toBe("http://127.0.0.1:18791/media/demooperator/media/id1.png");
    expect(existsSync(store.localPath!(key))).toBe(true);
    expect(new TextDecoder().decode(await readFile(store.localPath!(key)))).toBe("PNGDATA");

    await store.delete(key);
    expect(existsSync(store.localPath!(key))).toBe(false);

    await rm(dir, { recursive: true, force: true });
  });

  it("refuses to write outside the media dir", async () => {
    const dir = await mkdtemp(join(tmpdir(), "noelle-media-"));
    const store = createLocalContentStorage({ dir, publicBaseUrl: "http://h" });
    await expect(
      store.put({ key: "../escape.png", bytes: new Uint8Array([1]), contentType: "image/png" }),
    ).rejects.toThrow();
    await rm(dir, { recursive: true, force: true });
  });
});

describe("createGcsContentStorage", () => {
  it("resolves a fresh read URL without uploading bytes again", async () => {
    let signing = 0, writes = 0;
    const store = createGcsContentStorage({ bucket: "fixture", prefix: "tenant/",
      save: async () => { writes++; }, remove: async () => {},
      resolveUrl: (path) => `https://gcs.invalid/${path}?fresh=${++signing}` });
    const resolver = store.resolveUrl;
    expect(resolver, "stored assets need a read-time URL resolver").toBeTypeOf("function");
    expect(await resolver!("one/media/image.png")).toBe("https://gcs.invalid/tenant/one/media/image.png?fresh=1");
    expect(await resolver!("one/media/image.png")).toBe("https://gcs.invalid/tenant/one/media/image.png?fresh=2");
    expect(writes).toBe(0);
  });
  it("delegates to the injected ops and applies the prefix", async () => {
    const calls: string[] = [];
    const store = createGcsContentStorage({
      bucket: "noelle-vaults",
      prefix: "tenant/",
      save: async (p) => { calls.push(`save:${p}`); },
      resolveUrl: (p) => `https://gcs/${p}`,
      remove: async (p) => { calls.push(`remove:${p}`); },
    });
    const key = mediaKey("demooperator", "id1", "jpg");
    const { url } = await store.put({ key, bytes: new Uint8Array([1, 2]), contentType: "image/jpeg" });
    expect(url).toBe(`https://gcs/tenant/${key}`);
    await store.delete(key);
    expect(calls).toEqual([`save:tenant/${key}`, `remove:tenant/${key}`]);
  });
});
