import { createGcsContentStorage, type ContentStorage } from "@noelle/runtime/content-storage";
import { createGcsObjectClient } from "@noelle/runtime/gcs-objects";

/** Private object I/O shares GCS admission and its credential-plus-body deadline. */
export function createGcsMediaStorage(options: {
  bucket: string;
  getAccessToken(timeoutMs: number): Promise<string | null | undefined>;
  resolveUrl(key: string): Promise<string>;
  endpoint?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}): ContentStorage {
  const objects = createGcsObjectClient(options);
  return createGcsContentStorage({
    bucket: options.bucket,
    save: (key, bytes, contentType) => objects.write({ bucket: options.bucket, name: key, bytes, contentType, ifGenerationMatch: "0" }),
    resolveUrl: options.resolveUrl,
    remove: key => objects.remove({ bucket: options.bucket, name: key, ignoreNotFound: true }),
  });
}
