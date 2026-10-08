import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listExternalMedia, externalMediaRoot } from "./external-media";

// Scans a temp dir the way the Lima mount of content-pipeline's media would be
// scanned, and asserts the ContentMediaRow mapping the Media tab consumes.
describe("listExternalMedia", () => {
  let dir = "";
  const prev = process.env.NOELLE_EXTERNAL_MEDIA_DIR;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "ext-media-"));
    await mkdir(join(dir, "videos"), { recursive: true });
    await writeFile(join(dir, "videos", "IMG_4350.mov"), "fake");
    await writeFile(join(dir, "clip with space.mp4"), "fake");
    await writeFile(join(dir, "cover.png"), "fake");
    await writeFile(join(dir, "notes.txt"), "ignored"); // non-media → skipped
    await writeFile(join(dir, ".hidden.mp4"), "ignored"); // dotfile → skipped
    process.env.NOELLE_EXTERNAL_MEDIA_DIR = dir;
  });
  afterAll(async () => {
    if (prev === undefined) delete process.env.NOELLE_EXTERNAL_MEDIA_DIR;
    else process.env.NOELLE_EXTERNAL_MEDIA_DIR = prev;
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("returns [] when unconfigured", async () => {
    const saved = process.env.NOELLE_EXTERNAL_MEDIA_DIR;
    delete process.env.NOELLE_EXTERNAL_MEDIA_DIR;
    expect(externalMediaRoot()).toBeNull();
    expect(await listExternalMedia()).toEqual([]);
    process.env.NOELLE_EXTERNAL_MEDIA_DIR = saved;
  });

  it("scans videos + images recursively, skips non-media + dotfiles", async () => {
    const rows = await listExternalMedia();
    const names = rows.map((r) => r.caption).sort();
    expect(names).toEqual(["IMG_4350.mov", "clip with space.mp4", "cover.png"]);
    expect(rows.every((r) => r.id.startsWith("ext:"))).toBe(true);
    expect(rows.every((r) => r.status === "ready")).toBe(true);
  });

  it("maps kind + a same-origin /external-media url with encoded segments", async () => {
    const rows = await listExternalMedia();
    const mov = rows.find((r) => r.caption === "IMG_4350.mov")!;
    expect(mov.kind).toBe("video");
    expect(mov.url).toBe("/external-media/videos/IMG_4350.mov");
    const png = rows.find((r) => r.caption === "cover.png")!;
    expect(png.kind).toBe("image");
    const spaced = rows.find((r) => r.caption === "clip with space.mp4")!;
    expect(spaced.url).toBe("/external-media/clip%20with%20space.mp4");
  });
});
