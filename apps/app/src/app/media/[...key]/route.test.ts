import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, writeFile, truncate, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GET } from "./route.js";

const dirs: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});
async function media(bytes: number) {
  const dir = await mkdtemp(join(tmpdir(), "noelle-media-route-")); dirs.push(dir);
  await mkdir(join(dir, "org/media"), { recursive: true });
  const path = join(dir, "org/media/file.png");
  await writeFile(path, new Uint8Array([137, 80, 78, 71]));
  await truncate(path, bytes);
  vi.stubEnv("NOELLE_MEDIA_DIR", dir);
  return GET(new Request("https://app.test/media/org/media/file.png"), {
    params: Promise.resolve({ key: ["org", "media", "file.png"] }),
  });
}
describe("local content media route", () => {
  it("refuses a file larger than the decoded upload contract", async () => {
    const response = await media(11_250_001);
    expect(response.status).toBe(413);
  });
  it("serves existing bytes and preserves private MIME/cache headers", async () => {
    const response = await media(4);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("cache-control")).toBe("private, max-age=3600");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([137, 80, 78, 71]));
  });
  it("refuses traversal before accessing storage", async () => {
    expect((await GET(new Request("https://app.test/media"), {
      params: Promise.resolve({ key: ["..", "private"] }),
    })).status).toBe(400);
  });
});
