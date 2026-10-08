import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { resolve, extname } from "node:path";
import { Readable } from "node:stream";
import { externalMediaRoot } from "@/lib/external-media";

// Serve a file from the read-only external media mount (content-pipeline's
// clips). Streams with HTTP Range support so large videos seek without loading
// into memory. Path-traversal guarded to the configured root. Same-origin so
// the browser (incl. Tailscale on phone) can load thumbnails/playback.
// Single-operator self-host posture: matches /media/[...key] (capability-style,
// not separately auth-gated — the Tailscale origin is private).

const MIME: Record<string, string> = {
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
  ".m4v": "video/x-m4v",
  ".avi": "video/x-msvideo",
  ".mkv": "video/x-matroska",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".heic": "image/heic",
  ".heif": "image/heif",
  ".bmp": "image/bmp",
  ".tiff": "image/tiff",
};

export async function GET(req: Request, { params }: { params: Promise<{ path: string[] }> }) {
  const root = externalMediaRoot();
  if (!root) return new Response("external media not configured", { status: 404 });

  const { path } = await params;
  const rel = (path ?? []).map((p) => decodeURIComponent(p)).join("/");
  if (!rel || rel.includes("..") || rel.includes("\\")) {
    return new Response("bad path", { status: 400 });
  }
  const abs = resolve(root, rel);
  if (abs !== root && !abs.startsWith(root + "/")) {
    return new Response("forbidden", { status: 403 });
  }

  let s;
  try {
    s = await stat(abs);
  } catch {
    return new Response("not found", { status: 404 });
  }
  if (!s.isFile()) return new Response("not found", { status: 404 });

  const mime = MIME[extname(abs).toLowerCase()] ?? "application/octet-stream";
  const range = req.headers.get("range");
  const rangeMatch = range ? /^bytes=(\d+)-(\d*)$/.exec(range.trim()) : null;

  if (rangeMatch) {
    const start = Number(rangeMatch[1]);
    const end = rangeMatch[2] ? Math.min(Number(rangeMatch[2]), s.size - 1) : s.size - 1;
    if (Number.isNaN(start) || start > end || start >= s.size) {
      return new Response("range not satisfiable", { status: 416, headers: { "content-range": `bytes */${s.size}` } });
    }
    const web = Readable.toWeb(createReadStream(abs, { start, end })) as unknown as ReadableStream<Uint8Array>;
    return new Response(web, {
      status: 206,
      headers: {
        "content-type": mime,
        "content-range": `bytes ${start}-${end}/${s.size}`,
        "accept-ranges": "bytes",
        "content-length": String(end - start + 1),
        "cache-control": "private, max-age=3600",
      },
    });
  }

  const web = Readable.toWeb(createReadStream(abs)) as unknown as ReadableStream<Uint8Array>;
  return new Response(web, {
    status: 200,
    headers: {
      "content-type": mime,
      "content-length": String(s.size),
      "accept-ranges": "bytes",
      "cache-control": "private, max-age=3600",
    },
  });
}
