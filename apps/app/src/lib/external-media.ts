import { readdir, stat } from "node:fs/promises";
import { join, relative, resolve, extname } from "node:path";
import type { ContentMediaRow } from "./posts-queries";

// Optional read-only media folder, configured by NOELLE_EXTERNAL_MEDIA_DIR.
// Entries share ContentMediaRow with uploaded media and use ext:<relative path> IDs.

const VIDEO_EXT = new Set([".mp4", ".mov", ".webm", ".m4v", ".avi", ".mkv"]);
const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif", ".heic", ".heif", ".bmp", ".tiff"]);

/** The configured external media root (absolute), or null if unset. */
export function externalMediaRoot(): string | null {
  const d = process.env.NOELLE_EXTERNAL_MEDIA_DIR?.trim();
  return d ? resolve(d) : null;
}

interface Found {
  rel: string;
  name: string;
  size: number;
  mtime: number;
  kind: "video" | "image";
}

async function walk(dir: string, root: string, out: Found[], depth: number): Promise<void> {
  if (depth > 6 || out.length > 5000) return; // bound the scan
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.name.startsWith(".")) continue;
    const abs = join(dir, e.name);
    if (e.isDirectory()) {
      await walk(abs, root, out, depth + 1);
      continue;
    }
    const ext = extname(e.name).toLowerCase();
    const kind = VIDEO_EXT.has(ext) ? "video" : IMAGE_EXT.has(ext) ? "image" : null;
    if (!kind) continue;
    try {
      const s = await stat(abs);
      out.push({ rel: relative(root, abs), name: e.name, size: s.size, mtime: s.mtimeMs, kind });
    } catch {
      /* skip unreadable */
    }
  }
}

/**
 * Scan NOELLE_EXTERNAL_MEDIA_DIR for video/image files, newest first, mapped to
 * ContentMediaRow. Returns [] when unconfigured or the dir isn't readable (so a
 * missing mount degrades gracefully to "just the uploaded media").
 */
export async function listExternalMedia(): Promise<ContentMediaRow[]> {
  const root = externalMediaRoot();
  if (!root) return [];
  const found: Found[] = [];
  await walk(root, root, found, 0);
  found.sort((a, b) => b.mtime - a.mtime);
  return found.map((f) => ({
    id: `ext:${f.rel}`,
    platform: null,
    kind: f.kind,
    mime_type: null,
    // Same-origin serve route (Tailscale-reachable). Encode each segment.
    url: `/external-media/${f.rel.split("/").map(encodeURIComponent).join("/")}`,
    width: null,
    height: null,
    duration_ms: null,
    bytes: f.size,
    idea_id: null,
    draft_id: null,
    caption: f.name,
    status: "ready",
    created_at: new Date(f.mtime).toISOString(),
  }));
}
