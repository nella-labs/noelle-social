import { assertSafeKey } from "@noelle/runtime/content-storage";
import { readLocalContentMedia } from "@noelle/runtime/content-media-read";
import { HttpBodyError } from "@noelle/runtime/bounded-http";

// Serve content-media for the LOCAL storage backend (self-host). The api-vm
// writes bytes under NOELLE_MEDIA_DIR and stores url=`/media/<key>`; serving
// from the Next app (the only Tailscale-published origin) makes media reachable
// on every device. In prod the row's url is an absolute GCS URL, so this route
// is unused. Keys are `<orgId>/media/<uuid>.<ext>` — unguessable capability
// URLs (the uuid filename is the secret); acceptable for single-operator
// self-host. Prod multi-tenant isolation is handled by GCS, not this route.

const MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  mp4: "video/mp4",
  mov: "video/quicktime",
  webm: "video/webm",
};

export async function GET(req: Request, { params }: { params: Promise<{ key: string[] }> }) {
  const { key } = await params;
  const rel = key.join("/");
  try { assertSafeKey(rel); } catch {
    return new Response("bad key", { status: 400 });
  }
  const dir = process.env.NOELLE_MEDIA_DIR;
  if (!dir) return new Response("media not configured", { status: 404 });

  try {
    const buf = await readLocalContentMedia(dir, rel, { signal: req.signal });
    const ext = rel.split(".").pop()?.toLowerCase() ?? "";
    return new Response(new Uint8Array(buf), {
      headers: {
        "content-type": MIME[ext] ?? "application/octet-stream",
        "cache-control": "private, max-age=3600",
      },
    });
  } catch (error) {
    if (error instanceof HttpBodyError && error.code === "body_too_large") {
      return new Response("media too large", { status: 413 });
    }
    return new Response("not found", { status: 404 });
  }
}
