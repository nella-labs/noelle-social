export { readSourceCount as readXSourceCount, readSourceTimestamp as readXSourceTimestamp } from "@noelle/runtime/source-values";

/** Preserve exact nonzero numeric X platform identities. */
export function readXSourceId(...candidates: unknown[]): string | null {
  for (const value of candidates) {
    const id = typeof value === "string" ? value.trim()
      : typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? String(value) : "";
    if (/^[0-9]{1,25}$/.test(id) && !/^0+$/.test(id)) return id;
  }
  return null;
}
