import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { tmpdir } from "node:os";

const counts = vi.hoisted(() => ({ root: "", directories: 0, entries: 0, depth: 0 }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs/promises")>();
  const visited = (path: string) => {
    counts.directories += 1;
    const rel = relative(counts.root, path);
    counts.depth = Math.max(counts.depth, rel ? rel.split("/").length : 0);
  };
  return {
    ...fs,
    readdir: async (path: string, options: { withFileTypes: true }) => {
      visited(path);
      const entries = await fs.readdir(path, options);
      counts.entries += entries.length;
      return entries;
    },
    opendir: async (path: string, options?: { bufferSize?: number }) => {
      visited(path);
      const directory = await fs.opendir(path, options);
      const read = directory.read.bind(directory);
      Object.defineProperty(directory, "read", { value: async () => {
        const entry = await read();
        if (entry) counts.entries += 1;
        return entry;
      } });
      return directory;
    },
  };
});
import { listVaultMarkdown, readVaultFile } from "./vault-fs";

let dir = "";
beforeEach(async () => {
  dir = await realpath(await mkdtemp(join(tmpdir(), "vault-bounded-")));
  Object.assign(counts, { root: dir, directories: 0, entries: 0, depth: 0 });
});
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

test("empty folders cannot make a capped markdown scan walk more than 512 directories", async () => {
  await Promise.all(Array.from({ length: 513 }, (_, i) => mkdir(join(dir, `folder-${i}`))));
  expect(await listVaultMarkdown(dir)).toEqual([]);
  expect(counts.directories).toBeLessThanOrEqual(512);
});

test("directory entries are streamed with a global 4096 entry bound", async () => {
  for (let start = 0; start < 4097; start += 100) {
    await Promise.all(Array.from({ length: Math.min(100, 4097 - start) }, (_, i) => writeFile(join(dir, `entry-${start + i}.txt`), "")));
  }
  expect(await listVaultMarkdown(dir)).toEqual([]);
  expect(counts.entries).toBeLessThanOrEqual(4096);
});

test("a deep empty tree cannot exceed 32 directory levels", async () => {
  let path = dir;
  for (let i = 0; i < 40; i += 1) { path = join(path, `depth-${i}`); await mkdir(path); }
  expect(await listVaultMarkdown(dir)).toEqual([]);
  expect(counts.depth).toBeLessThanOrEqual(32);
});

test("regular file previews above 4 MiB are unavailable while complete multibyte edits remain readable", async () => {
  await writeFile(join(dir, "large.md"), "a".repeat(4 * 1024 * 1024 + 1));
  expect(await readVaultFile(dir, "large.md") === null).toBe(true);
  const complete = "é".repeat(50_000);
  await writeFile(join(dir, "complete.md"), complete);
  expect(await readVaultFile(dir, "complete.md")).toBe(complete);
});
