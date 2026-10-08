import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanVault } from "./scan.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "vault-scan-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("scanVault", () => {
  it("collects .md files with relPath + md5, ignoring non-md, dotfiles, and .obsidian", async () => {
    await mkdir(join(dir, "01-business"), { recursive: true });
    await mkdir(join(dir, ".obsidian"), { recursive: true });
    await writeFile(join(dir, "01-business", "company.md"), "# Co\n");
    await writeFile(join(dir, "top.md"), "# Top\n");
    await writeFile(join(dir, "image.png"), "binary");
    await writeFile(join(dir, ".secret.md"), "# hidden\n");
    await writeFile(join(dir, ".obsidian", "workspace.md"), "# cfg\n");

    const files = await scanVault(dir);
    const paths = files.map((f) => f.relPath).sort();
    expect(paths).toEqual(["01-business/company.md", "top.md"]);
    expect(files.every((f) => typeof f.md5 === "string" && f.md5.length > 0)).toBe(true);
  });

  it("returns [] for an empty vault", async () => {
    expect(await scanVault(dir)).toEqual([]);
  });
});
