#!/usr/bin/env node
// Ingest voice-anchor markdown into a per-org noelle vault.
//
// This script copies explicitly selected anchors into the configured vault. It
// checksum-skips unchanged files and NEVER deletes anything already in the
// destination, so it's safe to re-run after every edit.
//
// Usage:
//   node scripts/ingest-vault-anchors.mjs \
//     [--src <dir>] [--dest <vaultDir>] [--subdir voice-anchors] [--dry-run]
//   node scripts/ingest-vault-anchors.mjs --self-test
//
// Required: --src. Default --dest = $NOELLE_VAULT_DIR.
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

function parseFlags(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      flags[key] = next;
      i++;
    } else {
      flags[key] = true;
    }
  }
  return flags;
}

function sha256(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

// Recursively list relative paths of .md files under `dir`.
async function listMarkdown(dir, base = dir) {
  const out = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      out.push(...(await listMarkdown(full, base)));
    } else if (e.isFile() && e.name.toLowerCase().endsWith(".md")) {
      out.push(relative(base, full));
    }
  }
  return out;
}

/**
 * Copy every .md under `src` into `dest`, skipping files whose content already
 * matches. Returns { copied, skipped, files }. Never deletes from `dest`.
 */
export async function ingestAnchors({ src, dest, dryRun = false }) {
  const rels = await listMarkdown(src);
  let copied = 0;
  let skipped = 0;
  const files = [];
  for (const rel of rels) {
    const srcBuf = await readFile(join(src, rel));
    const destPath = join(dest, rel);
    let same = false;
    if (existsSync(destPath)) {
      try {
        const destBuf = await readFile(destPath);
        same = sha256(destBuf) === sha256(srcBuf);
      } catch {
        same = false;
      }
    }
    if (same) {
      skipped++;
      continue;
    }
    if (!dryRun) {
      await mkdir(join(dest, rel, ".."), { recursive: true });
      await writeFile(destPath, srcBuf);
    }
    copied++;
    files.push(rel);
  }
  return { copied, skipped, files };
}

async function selfTest() {
  const root = await mkdtemp(join(tmpdir(), "noelle-ingest-"));
  const src = join(root, "src");
  const dest = join(root, "dest");
  await mkdir(join(src, "nested"), { recursive: true });
  await writeFile(join(src, "ship.md"), "# ship\nfirst-person shipping cadence\n");
  await writeFile(join(src, "nested", "tone.md"), "# tone\n");
  await writeFile(join(src, "ignore.txt"), "not markdown");

  const first = await ingestAnchors({ src, dest });
  const second = await ingestAnchors({ src, dest });

  let ok = true;
  const checks = [];
  const assert = (name, cond) => {
    checks.push(`${cond ? "ok" : "FAIL"} — ${name}`);
    if (!cond) ok = false;
  };
  assert("first run copies both .md files", first.copied === 2);
  assert("first run skips the .txt (markdown only)", !first.files.includes("ignore.txt"));
  assert("second run copies nothing (idempotent)", second.copied === 0);
  assert("second run skips both", second.skipped === 2);
  assert("nested path preserved", existsSync(join(dest, "nested", "tone.md")));

  await rm(root, { recursive: true, force: true });
  console.log(checks.join("\n"));
  console.log(ok ? "\nself-test PASSED" : "\nself-test FAILED");
  process.exit(ok ? 0 : 1);
}

async function main() {
  const flags = parseFlags(process.argv.slice(2));
  if (flags["self-test"]) {
    await selfTest();
    return;
  }

  const src = typeof flags.src === "string" ? flags.src : null;
  if (!src) {
    console.error("error: pass --src <voice-anchor-directory>");
    process.exit(2);
  }
  const subdir = typeof flags.subdir === "string" ? flags.subdir : "voice-anchors";
  let dest = typeof flags.dest === "string" ? flags.dest : null;
  if (!dest) {
    const vaultDir = process.env.NOELLE_VAULT_DIR;
    if (!vaultDir) {
      console.error("error: pass --dest <vaultDir> or set NOELLE_VAULT_DIR");
      process.exit(2);
    }
    dest = join(vaultDir, subdir);
  }

  if (!existsSync(src) || !(await stat(src)).isDirectory()) {
    console.error(`error: source is not a directory: ${src}`);
    process.exit(2);
  }

  const dryRun = flags["dry-run"] === true;
  const { copied, skipped, files } = await ingestAnchors({ src, dest, dryRun });
  console.log(`${dryRun ? "[dry-run] " : ""}ingest ${src} → ${dest}`);
  console.log(`  copied: ${copied}  skipped: ${skipped}`);
  for (const f of files) console.log(`  + ${f}`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.stack : String(e));
  process.exit(1);
});
