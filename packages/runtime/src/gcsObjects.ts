import { createHash } from "node:crypto";
import { decodeHttpJson } from "./boundedHttp.js";
import { createGcsHttpRequest } from "./gcsHttp.js";

export class GcsObjectHttpError extends Error {
  constructor(readonly operation: "upload" | "read" | "deletion", readonly status: number) {
    super(`GCS object ${operation} rejected: ${status}`); this.name = "GcsObjectHttpError";
  }
}

type WriteArgs = {
  bucket: string; name: string; contentType: string; ifGenerationMatch?: "0";
} & ({ bytes: Uint8Array; text?: never } | { text: string; bytes?: never });

/** Complete object operations share GCS admission, credentials and body deadlines. */
export function createGcsObjectClient(options: Parameters<typeof createGcsHttpRequest>[0] & { endpoint?: string }) {
  const endpoint = (options.endpoint ?? "https://storage.googleapis.com").replace(/\/$/, "");
  const request = createGcsHttpRequest(options);
  const objectUrl = (bucket: string, name: string) => `${endpoint}/storage/v1/b/${encodeURIComponent(bucket)}/o/${encodeURIComponent(name)}`;
  return {
    async write(args: WriteArgs) {
      const { bucket, name, contentType, ifGenerationMatch } = args;
      const source = args.text ?? args.bytes;
      if (typeof source !== "string" && !(source instanceof Uint8Array)) throw new RangeError("Invalid GCS upload source");
      const size = typeof source === "string" ? Buffer.byteLength(source) : source.byteLength;
      if (size > 16 * 1024 * 1024) throw new RangeError("GCS upload exceeds its byte limit");
      const digest = createHash("md5").update(source).digest("base64");
      const url = new URL(`${endpoint}/upload/storage/v1/b/${encodeURIComponent(bucket)}/o`);
      url.searchParams.set("uploadType", "media"); url.searchParams.set("name", name);
      if (ifGenerationMatch !== undefined) url.searchParams.set("ifGenerationMatch", ifGenerationMatch);
      const { response, bytes } = await request(url, () => {
        const body = typeof source === "string" ? Buffer.from(source, "utf8") : Buffer.from(source);
        if (body.byteLength !== size || createHash("md5").update(body).digest("base64") !== digest) throw new Error("GCS upload source changed before dispatch");
        return { method: "POST", headers: { "content-type": contentType }, body };
      }, { maxBytes: 65_536 });
      if (!response.ok) throw new GcsObjectHttpError("upload", response.status);
      const receipt = decodeHttpJson(bytes) as Record<string, unknown> | null;
      if (!receipt || receipt.name !== name || receipt.bucket !== bucket ||
          receipt.size !== String(size) || receipt.md5Hash !== digest) {
        throw new Error("GCS upload returned an invalid object receipt");
      }
    },
    async read(args: { bucket: string; name: string; maxBytes: number }) {
      const url = new URL(objectUrl(args.bucket, args.name)); url.searchParams.set("alt", "media");
      const { response, bytes } = await request(url, { headers: { "accept-encoding": "identity" } }, { maxBytes: args.maxBytes });
      if (!response.ok) throw new GcsObjectHttpError("read", response.status);
      return Buffer.from(bytes);
    },
    async remove(args: { bucket: string; name: string; ignoreNotFound?: boolean }) {
      const { response } = await request(objectUrl(args.bucket, args.name), { method: "DELETE" }, { maxBytes: 65_536 });
      if (!response.ok && !(args.ignoreNotFound && response.status === 404)) throw new GcsObjectHttpError("deletion", response.status);
    },
  };
}
