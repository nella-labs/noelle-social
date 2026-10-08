import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { Readable } from "node:stream";
import { CONTENT_MEDIA_MAX_BYTES } from "@noelle/contracts";
import { localContentMediaPath } from "./contentStorage.js";
import { fetchBoundedHttpResponse, HttpBodyError, readBoundedHttpBytes } from "./boundedHttp.js";

interface MediaReadOptions { signal?: AbortSignal; timeoutMs?: number }

/** Read regular local files within the upload byte limit; own and close the file handle. */
export async function readLocalContentMedia(
  dir: string, key: string, options: MediaReadOptions = {},
): Promise<Uint8Array<ArrayBuffer>> {
  const timeoutMs = options.timeoutMs ?? 15_000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) {
    throw new RangeError("Invalid media read timeout");
  }
  const controller = new AbortController();
  const abort = () => controller.abort();
  options.signal?.addEventListener("abort", abort, { once: true });
  if (options.signal?.aborted) controller.abort();
  const timer = setTimeout(() => controller.abort(new HttpBodyError("timeout", "Media read timed out")), timeoutMs);
  let file: Awaited<ReturnType<typeof open>> | undefined;
  let stream: ReturnType<NonNullable<typeof file>["createReadStream"]> | undefined;
  try {
    controller.signal.throwIfAborted();
    // Nonblocking open prevents a misplaced FIFO from waiting for a writer.
    file = await open(localContentMediaPath(dir, key), constants.O_RDONLY | constants.O_NONBLOCK);
    const stat = await file.stat();
    controller.signal.throwIfAborted();
    if (!stat.isFile()) throw new Error("Media asset is not a regular file");
    if (stat.size > CONTENT_MEDIA_MAX_BYTES) {
      throw new HttpBodyError("body_too_large", "Media asset exceeds its byte limit");
    }
    if (stat.size === 0) return new Uint8Array();
    // Reading only the initial extent also bounds a file that grows after stat.
    stream = file.createReadStream({ autoClose: false, end: stat.size - 1,
      highWaterMark: 65_536, signal: controller.signal });
    return await readBoundedHttpBytes(new Response(Readable.toWeb(stream) as ReadableStream<Uint8Array<ArrayBuffer>>), {
      maxBytes: CONTENT_MEDIA_MAX_BYTES, signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", abort);
    stream?.destroy();
    await file?.close();
  }
}

/** Read local bytes first, then the URL, preserving unreadable-asset skip behavior. */
export async function readContentMedia(
  mediaDir: string | null, asset: { storage_key: string; url: string | null },
  options: MediaReadOptions = {},
): Promise<Uint8Array<ArrayBuffer> | null> {
  if (mediaDir) {
    try {
      const bytes = await readLocalContentMedia(mediaDir, asset.storage_key, options);
      if (bytes.length > 0) return bytes;
    } catch { /* Try the stored URL when local bytes are unavailable. */ }
  }
  if (asset.url) {
    try {
      const { response, bytes } = await fetchBoundedHttpResponse(asset.url, options.signal ? { signal: options.signal } : {}, {
        timeoutMs: options.timeoutMs ?? 15_000, maxBytes: CONTENT_MEDIA_MAX_BYTES,
      });
      if (response.ok && bytes.length > 0) return bytes;
    } catch { /* An unreadable attachment cannot block the existing publish flow. */ }
  }
  return null;
}
