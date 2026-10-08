import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import http from "node:http";
import https from "node:https";
import { mkdtemp, mkdir, writeFile, readFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { listVaultFileMeta, readVaultFile, readVaultSource, writeVaultFile as replaceVaultFile, vaultRoot, vaultRootIdentity, resolveVaultRoot } from "./vault-fs";
import { buildVaultDigest, prepareVaultSnapshot } from "./vault-snapshot";
const opening = vi.hoisted(() => ({ calls: 0, removePath: null as string | null }));
vi.mock("node:fs/promises", async (original) => {
  const fs = await original<typeof import("node:fs/promises")>();
  return { ...fs, open: async (...args: Parameters<typeof fs.open>) => {
    opening.calls++;
    if (args[0] === opening.removePath) { opening.removePath = null; await fs.unlink(args[0]); }
    return fs.open(...args);
  } };
});

beforeEach(() => {
  opening.calls = 0; opening.removePath = null;
  vi.spyOn(http, "request").mockImplementation(() => { throw new Error("HTTP forbidden in filesystem tests"); });
  vi.spyOn(https, "request").mockImplementation(() => { throw new Error("HTTPS forbidden in filesystem tests"); });
  vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("Fetch forbidden in filesystem tests"); }));
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

async function writeVaultFile(root: string | null, path: string, content: string) {
  const basis = (await prepareVaultSnapshot(root, path)).bases[path];
  const canonical = await resolveVaultRoot(root);
  return replaceVaultFile(root, path, content, {
    basis: basis ?? { version: 1, path, exists: false, rootIdentity: canonical ? await vaultRootIdentity(canonical) : "0".repeat(64) },
    assertActive: async () => {}, rootStillBound: async () => true,
  });
}

// Exercises the local-FS vault listing the dashboard Vault page uses on the
// self-host box (NOELLE_VAULT_DIR), instead of GCS. Mirrors the directory
// shape of the operator's Obsidian vault on the Lima VM.
describe("listVaultFileMeta", () => {
  let dir = "";
  let outside = "";
  const prev = process.env.NOELLE_VAULT_DIR;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "vault-fs-"));
    outside = await mkdtemp(join(tmpdir(), "vault-outside-"));
    await mkdir(join(dir, "02-brand"), { recursive: true });
    await mkdir(join(dir, "noelle-voice"), { recursive: true });
    await mkdir(join(dir, ".git"), { recursive: true });
    await writeFile(join(dir, "00-vault-map.md"), "# map");
    await writeFile(join(dir, "02-brand", "voice-and-style.md"), "write blunt");
    await writeFile(join(dir, "noelle-voice", "ship.md"), "ship it");
    await writeFile(join(dir, "notes.txt"), "ignored"); // non-md → skipped
    await writeFile(join(dir, ".git", "config.md"), "ignored"); // VCS dir → skipped
    await writeFile(join(outside, "private.md"), "Outside fixture text");
    await symlink(outside, join(dir, "linked"), "dir");
    await symlink(join(outside, "private.md"), join(dir, "leaf.md"));
    process.env.NOELLE_VAULT_DIR = dir;
  });
  afterAll(async () => {
    if (prev === undefined) delete process.env.NOELLE_VAULT_DIR;
    else process.env.NOELLE_VAULT_DIR = prev;
    if (dir) await rm(dir, { recursive: true, force: true });
    if (outside) await rm(outside, { recursive: true, force: true });
  });

  it("marks the listing incomplete when no vault dir is configured", async () => {
    const saved = process.env.NOELLE_VAULT_DIR;
    delete process.env.NOELLE_VAULT_DIR;
    expect(vaultRoot()).toBeNull();
    expect(await listVaultFileMeta(null)).toEqual({ files: [], partial: true, nextOffset: null });
    process.env.NOELLE_VAULT_DIR = saved;
  });

  it("lists every .md file with size + mtime, skipping non-md + VCS dirs", async () => {
    const { files: metas, partial, nextOffset } = await listVaultFileMeta(dir);
    expect(partial).toBe(false); expect(nextOffset).toBeNull();
    const rels = metas.map((m) => m.rel).sort();
    expect(rels).toEqual([
      "00-vault-map.md",
      "02-brand/voice-and-style.md",
      "noelle-voice/ship.md",
    ]);
    for (const m of metas) {
      expect(m.size).toBeGreaterThan(0);
      expect(() => new Date(m.updatedISO).toISOString()).not.toThrow();
      expect(m.updatedISO).toBe(new Date(m.updatedISO).toISOString());
    }
  });

  it.each(["linked/private.md", "leaf.md"])("rejects a symbolic-link read at %s", async (path) => {
    expect(await readVaultFile(dir, path)).toBeNull();
  });

  it.each(["linked/private.md", "leaf.md"])("does not truncate or write through a symbolic link at %s", async (path) => {
    expect((await writeVaultFile(dir, path, "Redirected edit")).ok).toBe(false);
    expect(await readFile(join(outside, "private.md"), "utf8")).toBe("Outside fixture text");
  });

  it("keeps legitimate nested reads and writes working", async () => {
    expect(await readVaultFile(dir, "02-brand/voice-and-style.md")).toBe("write blunt");
    expect(await writeVaultFile(dir, "new-rules/sub/voice.md", "Confirmed nested rules")).toEqual({ ok: true });
    expect(await readFile(join(dir, "new-rules/sub/voice.md"), "utf8")).toBe("Confirmed nested rules");
  });

  it("uses the explicit root even when the configured directory changes", async () => {
    process.env.NOELLE_VAULT_DIR = outside;
    try {
      expect(await readVaultFile(dir, "00-vault-map.md")).toBe("# map");
      expect(await readVaultFile(null, "00-vault-map.md")).toBeNull();
      expect(await writeVaultFile(null, "00-vault-map.md", "Unavailable edit")).toEqual({ ok: false, error: "no_vault" });
      expect(await buildVaultDigest(null)).toBeNull();
    } finally { process.env.NOELLE_VAULT_DIR = dir; }
  });

  it("keeps directory and FIFO leaves out of file operations without blocking", async () => {
    await mkdir(join(dir, "directory.md"));
    execFileSync("mkfifo", [join(dir, "pipe.md")], { timeout: 1_000 });
    for (const path of ["directory.md", "pipe.md"]) {
      expect(await readVaultFile(dir, path)).toBeNull();
      expect((await writeVaultFile(dir, path, "Invalid leaf edit")).ok).toBe(false);
    }
  });

  it("digests and metadata exclude symbolic links and non-regular leaves", async () => {
    const metadata = await listVaultFileMeta(dir);
    for (const path of ["leaf.md", "linked/private.md", "pipe.md", "directory.md"]) {
      expect(metadata.files.map((row) => row.rel)).not.toContain(path);
    }
    const digest = await buildVaultDigest(dir);
    expect(digest).toContain("write blunt");
    expect(digest).not.toContain("Outside fixture text");
  });

  it("preserves the character limit for multibyte content", async () => {
    expect(await writeVaultFile(dir, "unicode.md", "é".repeat(50_000))).toEqual({ ok: true });
    expect(await readVaultFile(dir, "unicode.md")).toHaveLength(50_000);
    expect(await writeVaultFile(dir, "unicode.md", "é".repeat(50_001))).toEqual({ ok: false, error: "too_large" });
    expect(await readVaultFile(dir, "unicode.md")).toHaveLength(50_000);
  });
  it("rejects invalid edited text before creating an atomic replacement", async () => {
    expect(await writeVaultFile(dir, "surrogate.md", "A\uD800B")).toEqual({ ok: false, error: "invalid_encoding" });
    expect(await readVaultFile(dir, "surrogate.md")).toBeNull();
  });
});

describe("bounded metadata pages", () => {
  let dir = "";
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "vault-fs-pages-"));
    for (let i = 0; i < 201; i++) await writeFile(join(dir, `${String(i).padStart(3, "0")}.md`), "Current source");
  });
  afterAll(async () => { if (dir) await rm(dir, { recursive: true, force: true }); });
  it("keeps the scan completeness flag through first and final captured pages", async () => {
    const first = await listVaultFileMeta(dir, { limit: 50 });
    expect(first).toMatchObject({ partial: true, nextOffset: 50 });
    expect(first.files).toHaveLength(50);
    const last = await listVaultFileMeta(dir, { offset: 150, limit: 50 });
    expect(last).toMatchObject({ partial: true, nextOffset: null });
    expect(last.files).toHaveLength(50);
    expect(last.files[0]?.rel).not.toBe(first.files[0]?.rel);
  });
  it("reports an unavailable root as incomplete rather than a confirmed empty vault", async () => {
    expect(await listVaultFileMeta(join(dir, "gone"))).toEqual({ files: [], partial: true, nextOffset: null });
  });
  it.each([{ limit: 0 }, { limit: 101 }, { offset: -1 }, { offset: 201 }, { offset: 0.5 }])("rejects invalid local paging %j", async (options) => {
    await expect(listVaultFileMeta(dir, options)).rejects.toBeInstanceOf(RangeError);
  });
  it("opens only the requested metadata slice rather than every captured file", async () => {
    const page = await listVaultFileMeta(dir, { limit: 3 });
    expect(page.files).toHaveLength(3); expect(opening.calls).toBe(3);
  });
  it("marks a real scan-to-open deletion partial and advances over captured paths", async () => {
    const raced = await mkdtemp(join(tmpdir(), "vault-fs-race-"));
    try {
      for (let i = 0; i < 3; i++) await writeFile(join(raced, `${i}.md`), "Current source");
      expect((await listVaultFileMeta(raced, { limit: 2 })).partial).toBe(false);
      const root = await resolveVaultRoot(raced);
      expect(root).not.toBeNull();
      opening.removePath = join(root!, "0.md");
      const page = await listVaultFileMeta(raced, { limit: 2 });
      expect(page).toMatchObject({ partial: true, nextOffset: 2 });
      expect(page.files.map((row) => row.rel)).toEqual(["1.md"]);
    } finally { await rm(raced, { recursive: true, force: true }); }
  });
  it("preserves a legitimate bounded UTF8 prefix ending inside a final character", async () => {
    await writeFile(join(dir, "prefix.md"), "éé");
    expect(await readVaultSource(dir, "prefix.md", { maxBytes: 3, prefix: true })).toMatchObject({ kind: "file", text: "é", complete: false, bytesRead: 3 });
    expect(await readVaultSource(dir, "prefix.md", { maxBytes: 4 })).toMatchObject({ kind: "file", text: "éé", complete: true, bytesRead: 4 });
  });
  it("rejects invalid interior UTF8 even when reading a prefix", async () => {
    await writeFile(join(dir, "invalid-prefix.md"), Buffer.from([0xff, 0x61, 0x62, 0x63]));
    expect(await readVaultSource(dir, "invalid-prefix.md", { maxBytes: 3, prefix: true })).toEqual({ kind: "invalid_encoding" });
  });
});
