import { createHash } from "node:crypto";

/**
 * Base64 MD5 of a buffer — the exact format GCS reports in
 * `object.metadata.md5Hash`, so daemon-local hashes compare directly
 * against remote listings without re-downloading objects.
 */
export function md5Base64(buf: Buffer): string {
  return createHash("md5").update(buf).digest("base64");
}
