import "server-only";
import { constants, type BigIntStats } from "node:fs";
import { mkdir, opendir, realpath, lstat, open, rename, unlink, type FileHandle } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { readBoundedHttpBytes } from "@noelle/runtime/bounded-http";
import { VAULT_EDIT_MAX_CHARACTERS } from "@noelle/contracts";
import { VAULT_LIST_DEFAULT_LIMIT, VAULT_LIST_PAGE_LIMIT } from "@noelle/runtime/vault-storage";
import { VAULT_TEXT_MAX_BYTES, decodeVaultText, assertVaultText, VaultSourceEncodingError } from "@noelle/runtime/vault-text";

/**
 * Local vault operations receive an organization-bound root from their caller.
 * Descendant symlinks and non-regular files are excluded from reads and writes.
 * Directory checks do not provide atomic confinement against an independent
 * local process repeatedly replacing ancestor directories.
 */

export function vaultRoot(): string | null {
  const d = process.env.NOELLE_VAULT_DIR?.trim();
  return d ? d : null;
}

export async function resolveVaultRoot(root: string | null): Promise<string | null> {
  if (!root) return null;
  try {
    const resolved = await realpath(root);
    return (await lstat(resolved)).isDirectory() ? resolved : null;
  } catch { return null; }
}

type DirectoryIdentity = { path: string; dev: number; ino: number };

async function vaultParents(root: string, rel: string, create: boolean): Promise<DirectoryIdentity[]> {
  const parents: DirectoryIdentity[] = [];
  let path = root;
  for (const part of ["", ...rel.split("/").slice(0, -1).filter(Boolean)]) {
    if (part) path = join(path, part);
    if (create && part) {
      try { await mkdir(path); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    }
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("unsafe_path");
    parents.push({ path, dev: info.dev, ino: info.ino });
  }
  return parents;
}

async function parentsUnchanged(parents: DirectoryIdentity[]): Promise<boolean> {
  for (const parent of parents) {
    const info = await lstat(parent.path);
    if (!info.isDirectory() || info.isSymbolicLink() || info.dev !== parent.dev || info.ino !== parent.ino) return false;
  }
  return true;
}

async function openVaultFile(root: string, rel: string, writable = false): Promise<FileHandle> {
  const parents = await vaultParents(root, rel, false);
  const path = join(root, rel);
  const flags = constants.O_NOFOLLOW | constants.O_NONBLOCK | (writable ? constants.O_WRONLY : constants.O_RDONLY);
  const handle = await open(path, flags, 0o666);
  try {
    const info = await handle.stat();
    const current = await lstat(path);
    if (!info.isFile() || !current.isFile() || info.dev !== current.dev || info.ino !== current.ino || !await parentsUnchanged(parents)) {
      throw new Error("unsafe_path");
    }
    return handle;
  } catch (error) { await handle.close(); throw error; }
}

// Never index VCS / editor / dependency / trash dirs (or the media symlink).
const SKIP_DIRS = new Set([".git", ".obsidian", "node_modules", ".trash"]);
export const VAULT_LOCAL_SCAN_FILE_LIMIT = 200;
export interface VaultMarkdownScan { files: string[]; partial: boolean }
type ScanWork = VaultMarkdownScan & { directories: number; entries: number };

async function walk(dir: string, root: string, state: ScanWork, depth: number): Promise<void> {
  if (state.files.length >= VAULT_LOCAL_SCAN_FILE_LIMIT || state.directories >= 512 || state.entries >= 4096 || depth > 32) {
    state.partial = true;
    return;
  }
  state.directories += 1;
  let directory;
  try {
    await vaultParents(root, `${relative(root, dir)}/listing.md`, false);
    directory = await opendir(dir, { bufferSize: 32 });
    while (state.files.length < VAULT_LOCAL_SCAN_FILE_LIMIT && state.entries < 4096) {
      const e = await directory.read();
      if (!e) return;
      state.entries += 1;
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name) || e.name.startsWith(".")) continue;
        await walk(join(dir, e.name), root, state, depth + 1);
      } else if (e.isFile() && e.name.toLowerCase().endsWith(".md")) {
        state.files.push(relative(root, join(dir, e.name)));
      }
    }
    state.partial = true;
  } catch { state.partial = true; }
  finally { await directory?.close().catch(() => {}); }
}

export async function scanVaultMarkdown(boundRoot: string | null): Promise<VaultMarkdownScan> {
  const root = await resolveVaultRoot(boundRoot);
  if (!root) return { files: [], partial: true };
  const state: ScanWork = { files: [], partial: false, directories: 0, entries: 0 };
  await walk(root, root, state, 0);
  return { files: state.files.sort(), partial: state.partial };
}

/** Vault-relative markdown paths from a bounded scan. */
export async function listVaultMarkdown(boundRoot: string | null): Promise<string[]> {
  return (await scanVaultMarkdown(boundRoot)).files;
}

/** One vault markdown file's listing metadata (vault-relative path + size + mtime). */
export interface VaultFileMetaFs {
  /** Vault-root-relative path, e.g. `02-brand/voice-and-style.md`. */
  rel: string;
  /** Size in bytes. */
  size: number;
  /** Last-modified time, ISO-8601. */
  updatedISO: string;
}

export interface VaultFileMetadataPage {
  files: VaultFileMetaFs[];
  partial: boolean;
  nextOffset: number | null;
}

/** One metadata page from the existing bounded scan, including unread or raced entries. */
export async function listVaultFileMeta(
  boundRoot: string | null,
  options: { offset?: number; limit?: number } = {},
): Promise<VaultFileMetadataPage> {
  const offset = options.offset ?? 0, limit = options.limit ?? VAULT_LIST_DEFAULT_LIMIT;
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > VAULT_LOCAL_SCAN_FILE_LIMIT ||
      !Number.isSafeInteger(limit) || limit < 1 || limit > VAULT_LIST_PAGE_LIMIT) {
    throw new RangeError("Invalid local vault listing page");
  }
  const root = await resolveVaultRoot(boundRoot);
  if (!root) return { files: [], partial: true, nextOffset: null };
  const scan = await scanVaultMarkdown(root);
  const rels = scan.files.slice(offset, offset + limit);
  let partial = scan.partial;
  const out: VaultFileMetaFs[] = [];
  for (const rel of rels) {
    try {
      const handle = await openVaultFile(root, rel);
      try {
        const info = await handle.stat();
        out.push({ rel, size: info.size, updatedISO: new Date(info.mtimeMs).toISOString() });
      } finally { await handle.close(); }
    } catch {
      partial = true;
    }
  }
  return { files: out, partial, nextOffset: offset + limit < scan.files.length ? offset + limit : null };
}

/** A vault-relative path is editable/readable only if it stays inside the vault. */
export function isSafeVaultPath(rel: string): boolean {
  if (!rel || rel.startsWith("/") || rel.includes("..") || rel.includes("\0")) return false;
  return rel.toLowerCase().endsWith(".md");
}

export interface VaultFileIdentity {
  dev: string; ino: string; size: string; mtimeNs: string; ctimeNs: string;
}
export interface VaultFileBasis {
  version: 1; path: string; rootIdentity: string; exists: boolean;
  contentSha256?: string; fileIdentity?: VaultFileIdentity;
}
export type VaultSourceRead =
  | { kind: "file"; text: string; complete: boolean; identity: VaultFileIdentity; contentSha256: string; bytesRead: number }
  | { kind: "missing" | "unavailable" | "too_large" | "invalid_encoding" | "changed" };
export const VAULT_PREVIEW_MAX_BYTES = VAULT_TEXT_MAX_BYTES;
export const VAULT_COMPLETE_MAX_BYTES = VAULT_EDIT_MAX_CHARACTERS * 4;

function fileIdentity(info: BigIntStats): VaultFileIdentity {
  return { dev: String(info.dev), ino: String(info.ino), size: String(info.size), mtimeNs: String(info.mtimeNs), ctimeNs: String(info.ctimeNs) };
}
export function sameVaultFileIdentity(a: VaultFileIdentity, b: VaultFileIdentity): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
}
export async function vaultRootIdentity(root: string): Promise<string> {
  const info = await lstat(root, { bigint: true });
  return createHash("sha256").update(`${root}\0${info.dev}\0${info.ino}`).digest("hex");
}

/** Read only a bounded initial extent, and reject changed or invalid complete text. */
export async function readVaultSource(
  boundRoot: string | null, rel: string, options: { maxBytes: number; prefix?: boolean; signal?: AbortSignal },
): Promise<VaultSourceRead> {
  const root = await resolveVaultRoot(boundRoot);
  if (!root || !isSafeVaultPath(rel) || !Number.isSafeInteger(options.maxBytes) || options.maxBytes < 1 || options.maxBytes > VAULT_PREVIEW_MAX_BYTES) return { kind: "unavailable" };
  try {
    const handle = await openVaultFile(root, rel);
    let stream: ReturnType<FileHandle["createReadStream"]> | undefined;
    try {
      const before = await handle.stat({ bigint: true });
      const complete = before.size <= BigInt(options.maxBytes);
      if (!complete && !options.prefix) return { kind: "too_large" };
      const extent = Number(complete ? before.size : BigInt(options.maxBytes));
      let bytes: Uint8Array = new Uint8Array();
      if (extent) {
        stream = handle.createReadStream({ autoClose: false, start: 0, end: extent - 1, highWaterMark: 65_536, ...(options.signal ? { signal: options.signal } : {}) });
        bytes = await readBoundedHttpBytes(new Response(Readable.toWeb(stream) as ReadableStream<Uint8Array>), { maxBytes: options.maxBytes, ...(options.signal ? { signal: options.signal } : {}) });
      }
      const identity = fileIdentity(before);
      if (bytes.byteLength !== extent || !sameVaultFileIdentity(identity, fileIdentity(await handle.stat({ bigint: true })))) return { kind: "changed" };
      let text: string;
      try { text = decodeVaultText(bytes, { complete }); }
      catch { return { kind: "invalid_encoding" }; }
      return { kind: "file", text, complete, identity, contentSha256: createHash("sha256").update(bytes).digest("hex"), bytesRead: bytes.byteLength };
    } finally { stream?.destroy(); await handle.close(); }
  } catch (error) {
    return { kind: (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "unavailable" };
  }
}

/** A complete regular-file preview, or null when missing, unsafe or above the preview limit. */
export async function readVaultFile(boundRoot: string | null, rel: string): Promise<string | null> {
  const result = await readVaultSource(boundRoot, rel, { maxBytes: VAULT_PREVIEW_MAX_BYTES });
  return result.kind === "file" ? result.text : null;
}

export interface VaultWriteGuard {
  basis: VaultFileBasis;
  assertActive(): Promise<void>;
  rootStillBound(): Promise<boolean>;
  signal?: AbortSignal;
  /** Called immediately before the rename is submitted, when its outcome can become uncertain. */
  onRenameAdmitted?(): void;
}

/** Replace complete captured text while the caller retains its cooperative writer lease. */
export async function writeVaultFile(
  boundRoot: string | null,
  rel: string,
  content: string,
  guard: VaultWriteGuard,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const root = await resolveVaultRoot(boundRoot);
  if (!root) return { ok: false, error: "no_vault" };
  if (!isSafeVaultPath(rel)) return { ok: false, error: "unsafe_path" };
  if (content.length === 0) return { ok: false, error: "empty" };
  if (content.length > VAULT_EDIT_MAX_CHARACTERS) return { ok: false, error: "too_large" };
  if (!guard?.basis || guard.basis.path !== rel) return { ok: false, error: "refresh_required" };
  try { assertVaultText(content); }
  catch (error) {
    if (error instanceof VaultSourceEncodingError) return { ok: false, error: "invalid_encoding" };
    if (error instanceof RangeError) return { ok: false, error: "too_large" };
    throw error;
  }
  const bytes = Buffer.from(content, "utf8");
  const desiredHash = createHash("sha256").update(bytes).digest("hex");
  let temp: string | undefined;
  try {
    const rootCurrent = async () => await guard.rootStillBound() && await vaultRootIdentity(root) === guard.basis.rootIdentity;
    if (!await rootCurrent()) return { ok: false, error: "refresh_required" };
    await guard.assertActive();
    const current = async () => readVaultSource(root, rel, { maxBytes: VAULT_COMPLETE_MAX_BYTES, ...(guard.signal ? { signal: guard.signal } : {}) });
    const matchesBasis = (source: VaultSourceRead) => guard.basis.exists
      ? source.kind === "file" && source.complete && source.contentSha256 === guard.basis.contentSha256 && Boolean(guard.basis.fileIdentity && sameVaultFileIdentity(source.identity, guard.basis.fileIdentity))
      : source.kind === "missing";
    const source = await current();
    if (source.kind === "file" && source.complete && source.contentSha256 === desiredHash) {
      if (!await rootCurrent()) return { ok: false, error: "refresh_required" };
      await guard.assertActive();
      return { ok: true };
    }
    if (!matchesBasis(source)) return { ok: false, error: "conflict" };
    const parents = await vaultParents(root, rel, true);
    let mode = 0o666;
    if (guard.basis.exists) {
      const permission = await openVaultFile(root, rel, true);
      try { mode = (await permission.stat()).mode & 0o777; }
      finally { await permission.close(); }
    }
    temp = join(dirname(join(root, rel)), `.noelle-vault-${randomUUID()}.tmp`);
    const handle = await open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, mode);
    try {
      if (guard.basis.exists) await handle.chmod(mode);
      await handle.writeFile(bytes);
      await handle.sync();
    } finally { await handle.close(); }
    if (!await rootCurrent()) return { ok: false, error: "refresh_required" };
    if (!await parentsUnchanged(parents) || !matchesBasis(await current())) return { ok: false, error: "conflict" };
    await guard.assertActive();
    guard.onRenameAdmitted?.();
    await rename(temp, join(root, rel));
    temp = undefined;
    return { ok: true };
  } catch {
    return { ok: false, error: "write_failed" };
  } finally {
    if (temp) await unlink(temp).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; });
  }
}
