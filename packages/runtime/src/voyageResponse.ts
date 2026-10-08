import { searchResultLimit } from "./searchLimit.js";

/** One positional embedding contract serves ordinary rows and contextual chunks. */
export function parseVoyageEmbeddingRows(rows: unknown, count: number): number[][] | null {
  if (!Array.isArray(rows) || rows.length !== count) return null;
  const out: number[][] = new Array(count);
  for (const row of rows) {
    const index = row?.index;
    if (!Number.isInteger(index) || index < 0 || index >= count || out[index] !== undefined ||
      !Array.isArray(row.embedding) || row.embedding.length === 0 ||
      !row.embedding.every((value: unknown) => typeof value === "number" && Number.isFinite(value))) return null;
    out[index] = row.embedding;
  }
  return out;
}

/** Validate the selection limit before either ranking lane dispatches work. */
export function voyageTopK(count: number, requested = count): number {
  return searchResultLimit(requested, count);
}

/** Preserve omitted candidates after a partial ranking without changing received order. */
export function completeVoyageOrder(ranked: readonly number[], count: number): number[] {
  const seen = new Set(ranked);
  const order = [...ranked];
  for (let index = 0; index < count; index++) if (!seen.has(index)) order.push(index);
  return order;
}

// Bounds streamed provider bodies for embedding and rerank callers.
export const VOYAGE_MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
