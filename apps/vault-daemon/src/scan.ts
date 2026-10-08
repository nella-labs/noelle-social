import { readdir, readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { md5Base64 } from "./hash.js";
import type { FileRef } from "./reconcile.js";

/**
 * Recursively walk `root` and return one `FileRef` per markdown file,
 * keyed by POSIX-style vault-relative path. Skips dotfiles/dot-dirs
 * (including `.obsidian/`, `.trash/`) and anything that is not `*.md`.
 */
export async function scanVault(root: string): Promise<FileRef[]> {
  const out: FileRef[] = [];
  await walk(root, root, out);
  return out;
}

async function walk(root: string, dir: string, out: FileRef[]): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue; // dotfiles + .obsidian/.trash
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      await walk(root, full, out);
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
      const buf = await readFile(full);
      const relPath = relative(root, full).split(sep).join("/");
      out.push({ relPath, md5: md5Base64(buf) });
    }
  }
}
