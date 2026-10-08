import { describe, it, expect, afterEach, vi } from "vitest";
import { mkdir, writeFile, rm, truncate } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { randomUUID } from "node:crypto";
import type { Sql } from "postgres";
import type { XWriteClient } from "@noelle/x-client";
import { uploadSlotMedia } from "./content-publish-tick.js";

// A fake postgres.js tag returning canned rows for loadSlotImageMedia's SELECT.
function fakeSql(selectRows: unknown[]): Sql {
  return (() => Promise.resolve(selectRows)) as unknown as Sql;
}

// A fake X write client that records uploadMedia calls and hands back ids.
function fakeClient(): { client: XWriteClient; uploads: Array<{ mimeType: string; len: number }> } {
  const uploads: Array<{ mimeType: string; len: number }> = [];
  let n = 0;
  const client: XWriteClient = {
    handle: "vega",
    async uploadMedia({ bytes, mimeType }) {
      uploads.push({ mimeType, len: bytes.length });
      return { mediaId: `m${++n}` };
    },
    async postTweet() {
      return { id: "t", url: "https://x.com/vega/status/t" };
    },
    async getTweetMetrics() {
      return [];
    },
    async getMyAccount() {
      return {
        id: "1",
        handle: "vega",
        displayName: null,
        followers: null,
        following: null,
        posts: null,
      };
    },
  };
  return { client, uploads };
}

const dirs: string[] = [];
const scope = { orgId: "org", instanceId: "instance" };
async function seedMediaFile(bytes: Uint8Array): Promise<{ root: string; storageKey: string }> {
  const root = join(tmpdir(), `noelle-media-${randomUUID()}`);
  dirs.push(root);
  const storageKey = `acme/media/${randomUUID()}.png`;
  const p = join(root, storageKey);
  await mkdir(dirname(p), { recursive: true });
  await writeFile(p, bytes);
  return { root, storageKey };
}

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(
    dirs.splice(0).map((d) => rm(d, { recursive: true, force: true }).catch(() => {})),
  );
});

describe("uploadSlotMedia", () => {
  it("reads the fresh resolved URL instead of an expired stored capability", async () => {
    const descriptor = { id: "media-one", storage_key: "acme/media/one.png",
      url: "https://storage.googleapis.com/fixture/one?expired=1", mime_type: "image/png", fingerprint: "original" };
    const resolve = vi.fn(async () => [{ id: descriptor.id, url: "https://storage.googleapis.com/fixture/one?fresh=1" }]);
    const requested: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async url => {
      requested.push(String(url)); return String(url).includes("fresh=1")
        ? new Response(new Uint8Array([1, 2, 3])) : new Response("expired", { status: 403 });
    }));
    const { client, uploads } = fakeClient();
    const ids = await uploadSlotMedia(fakeSql([descriptor]), client, "draft-one", null, scope, resolve);
    expect(ids).toEqual(["m1"]); expect(uploads).toEqual([{ mimeType: "image/png", len: 3 }]);
    expect(resolve).toHaveBeenCalledWith([descriptor.id]);
    expect(requested).toEqual(["https://storage.googleapis.com/fixture/one?fresh=1"]);
    expect(descriptor.url).toContain("expired=1"); expect(descriptor.fingerprint).toBe("original");
  });
  it("does not fetch a stale URL when the resolver cannot acknowledge the asset", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(new Uint8Array([1]))));
    const { client, uploads } = fakeClient();
    const resolve = async () => [];
    expect(await uploadSlotMedia(fakeSql([{ id: "missing", storage_key: "one",
      url: "https://storage.googleapis.com/fixture/expired", mime_type: "image/png" }]), client, "draft-one", null, scope, resolve)).toEqual([]);
    expect(fetch).not.toHaveBeenCalled(); expect(uploads).toEqual([]);
  });
  it("skips a local asset above the upload contract's decoded byte limit", async () => {
    const { root, storageKey } = await seedMediaFile(new Uint8Array([1]));
    await truncate(join(root, storageKey), 11_250_001);
    const { client, uploads } = fakeClient();
    const ids = await uploadSlotMedia(fakeSql([{ storage_key: storageKey, url: null, mime_type: "image/png" }]),
      client, "draft-1", root, scope);
    expect(ids).toEqual([]);
    expect(uploads).toEqual([]);
  });

  it("skips an oversized URL body even when its content-length claims one byte", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(new Uint8Array(11_250_001), {
      headers: { "content-length": "1" },
    })));
    const { client, uploads } = fakeClient();
    const ids = await uploadSlotMedia(fakeSql([{ storage_key: "acme/media/large.png", url: "https://media.test/large", mime_type: "image/png" }]),
      client, "draft-1", null, scope);
    expect(ids).toEqual([]);
    expect(uploads).toEqual([]);
  });

  it("reads an attached image from the local media dir and uploads it", async () => {
    const bytes = new Uint8Array([137, 80, 78, 71, 1, 2, 3]); // PNG-ish bytes
    const { root, storageKey } = await seedMediaFile(bytes);
    const sql = fakeSql([{ storage_key: storageKey, url: null, mime_type: "image/png" }]);
    const { client, uploads } = fakeClient();

    const ids = await uploadSlotMedia(sql, client, "draft-1", root, scope);

    expect(ids).toEqual(["m1"]);
    expect(uploads).toEqual([{ mimeType: "image/png", len: bytes.length }]);
  });

  it("returns [] (no attach) when the draft has no media", async () => {
    const { client, uploads } = fakeClient();
    const ids = await uploadSlotMedia(fakeSql([]), client, "draft-1", "/tmp/whatever", scope);
    expect(ids).toEqual([]);
    expect(uploads).toHaveLength(0);
  });

  it("skips an unreadable asset (missing file, no url) instead of blocking the post", async () => {
    const sql = fakeSql([
      { storage_key: "acme/media/gone.png", url: null, mime_type: "image/png" },
    ]);
    const { client, uploads } = fakeClient();
    const ids = await uploadSlotMedia(
      sql,
      client,
      "draft-1",
      join(tmpdir(), `noelle-empty-${randomUUID()}`),
      scope,
    );
    expect(ids).toEqual([]);
    expect(uploads).toHaveLength(0);
  });

  it("returns [] for a slot with no draft bound", async () => {
    const { client } = fakeClient();
    expect(
      await uploadSlotMedia(
        fakeSql([{ storage_key: "x", url: null, mime_type: "image/png" }]),
        client,
        null,
        null,
        scope,
      ),
    ).toEqual([]);
  });
});
