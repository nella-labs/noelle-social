import { createHash } from "node:crypto";
import { decodeHttpJson } from "./boundedHttp.js";
import { createGcsHttpRequest } from "./gcsHttp.js";
import { GCS_METADATA_PAGE_LIMIT, GCS_METADATA_PAGE_TOKEN_LIMIT } from "./gcsLimits.js";

export const GCS_MARKDOWN_FILE_BYTES = 200_000;
export type GcsReadBudget = { timeoutMs?: number };
export type GcsListOptions = GcsReadBudget & { prefix?: string; autoPaginate?: false; maxResults?: number; pageToken?: string };
export interface GcsStorageFile {
  name: string;
  metadata: { updated?: string; size?: string | number; generation?: string; metageneration?: string; md5Hash?: string; contentEncoding?: string };
  download(options?: GcsReadBudget): Promise<Buffer[]>;
}
export interface GcsStorageReader {
  bucket(name: string): {
    getFiles(options: GcsListOptions): Promise<[GcsStorageFile[], { pageToken: string }?]>;
  };
}
function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
/** One bounded metadata page and generation-pinned object download per request. */
export function createGcsStorageReader(options: {
  endpoint?: string;
  getAccessToken(timeoutMs: number): Promise<string | null | undefined>;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}): GcsStorageReader {
  const endpoint = (options.endpoint ?? "https://storage.googleapis.com").replace(/\/$/, "");
  const request = createGcsHttpRequest(options);
  return { bucket(bucket) {
    const base = `${endpoint}/storage/v1/b/${encodeURIComponent(bucket)}/o`;
    return { async getFiles(args) {
      const maxResults = args.maxResults ?? GCS_METADATA_PAGE_LIMIT;
      if (!Number.isSafeInteger(maxResults) || maxResults < 1 || maxResults > GCS_METADATA_PAGE_LIMIT ||
          (args.pageToken !== undefined && (typeof args.pageToken !== "string" || !args.pageToken || args.pageToken.length > GCS_METADATA_PAGE_TOKEN_LIMIT))) {
        throw new RangeError("Invalid GCS metadata page");
      }
      const url = new URL(base);
      url.searchParams.set("maxResults", String(maxResults));
      if (args.prefix !== undefined) url.searchParams.set("prefix", args.prefix);
      if (args.pageToken !== undefined) url.searchParams.set("pageToken", args.pageToken);
      url.searchParams.set("fields", "items(name,bucket,size,updated,generation,metageneration,md5Hash,contentEncoding),nextPageToken");
      const { response, bytes } = await request(url, {}, { maxBytes: 1_048_576, ...args });
      if (!response.ok) throw new Error(`GCS metadata rejected: ${response.status}`);
      const page = decodeHttpJson(bytes);
      if (!record(page) || (page.items !== undefined && !Array.isArray(page.items)) ||
          (page.nextPageToken !== undefined && (typeof page.nextPageToken !== "string" ||
            !page.nextPageToken || page.nextPageToken.length > GCS_METADATA_PAGE_TOKEN_LIMIT))) throw new Error("Invalid GCS metadata page");
      const items = (page.items ?? []) as unknown[];
      if (items.length > maxResults) throw new Error("GCS metadata page exceeds its limit");
      const files = items.map((item): GcsStorageFile => {
        if (!record(item) || typeof item.name !== "string" || !item.name || item.name.length > 1024 ||
            !item.name.startsWith(args.prefix ?? "") || item.bucket !== bucket ||
            typeof item.size !== "string" || !/^\d+$/.test(item.size) || !Number.isSafeInteger(Number(item.size)) ||
            typeof item.generation !== "string" || !/^[1-9]\d{0,24}$/.test(item.generation) ||
            typeof item.metageneration !== "string" || !/^[1-9]\d{0,24}$/.test(item.metageneration) ||
            typeof item.updated !== "string" || !Number.isFinite(Date.parse(item.updated)) ||
            (item.md5Hash !== undefined && typeof item.md5Hash !== "string") ||
            (item.contentEncoding !== undefined && (typeof item.contentEncoding !== "string" ||
              item.contentEncoding.length > 128))) throw new Error("Invalid GCS object metadata");
        const metadata = { size: item.size, generation: item.generation, metageneration: item.metageneration, updated: item.updated,
          ...(typeof item.contentEncoding === "string" ? { contentEncoding: item.contentEncoding } : {}),
          ...(typeof item.md5Hash === "string" ? { md5Hash: item.md5Hash } : {}) };
        const name = item.name;
        return { name, metadata, async download(budget = {}) {
          const encoding = metadata.contentEncoding?.trim().toLowerCase() ?? "identity";
          if (encoding !== "gzip" && encoding !== "identity") throw new Error("Unsupported GCS source encoding");
          if (encoding === "identity" && Number(metadata.size) > GCS_MARKDOWN_FILE_BYTES) throw new Error("GCS source exceeds its byte limit");
          const objectUrl = new URL(`${base}/${encodeURIComponent(name)}`);
          objectUrl.searchParams.set("alt", "media"); objectUrl.searchParams.set("generation", metadata.generation);
          objectUrl.searchParams.set("ifMetagenerationMatch", metadata.metageneration);
          const result = await request(objectUrl, { headers: { "accept-encoding": "identity" } }, { maxBytes: GCS_MARKDOWN_FILE_BYTES, ...budget });
          if (!result.response.ok) throw new Error(`GCS source rejected: ${result.response.status}`);
          // GCS transcoding and native fetch decode gzip. Stored checksums cover compressed bytes.
          if (encoding === "identity" && (result.bytes.byteLength !== Number(metadata.size) || (metadata.md5Hash !== undefined &&
              createHash("md5").update(result.bytes).digest("base64") !== metadata.md5Hash))) {
            throw new Error("GCS source does not match its listed generation");
          }
          return [Buffer.from(result.bytes)];
        } };
      });
      return page.nextPageToken === undefined ? [files] : [files, { pageToken: page.nextPageToken as string }];
    } };
  } };
}
