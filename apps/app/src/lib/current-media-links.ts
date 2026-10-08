import { CONTENT_MEDIA_RESOLVE_MAX_IDS, parseContentMediaReceipt } from "@noelle/contracts";
import { noelleFetch } from "@/lib/api";

function storedGcsLink(url: string | null): boolean {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && (parsed.hostname === "storage.googleapis.com" || parsed.hostname.endsWith(".storage.googleapis.com"));
  } catch { return false; }
}

/** Refresh ready GCS capabilities with one HTTP refresh budget; local and external media retain their URLs. */
export async function currentMediaLinks<T extends { id: string; status: string; url: string | null }>(
  orgId: string, rows: readonly T[],
): Promise<T[]> {
  const ids = rows.filter(row => row.status === "ready" && storedGcsLink(row.url)).map(row => row.id);
  const urls = new Map<string, string | null>(ids.map(id => [id.toLowerCase(), null]));
  const deadline = performance.now() + 30_000;
  for (let offset = 0; offset < ids.length; offset += CONTENT_MEDIA_RESOLVE_MAX_IDS) {
    const batch = ids.slice(offset, offset + CONTENT_MEDIA_RESOLVE_MAX_IDS);
    const remainingMs = Math.floor(deadline - performance.now());
    if (remainingMs <= 0) break;
    try {
      const receipt = await noelleFetch("/api/content-media/resolve", { method: "POST",
        body: { orgId, ids: batch }, timeoutMs: remainingMs });
      for (const row of parseContentMediaReceipt(receipt, batch)) urls.set(row.id.toLowerCase(), row.url);
    } catch { /* An expired capability cannot be presented as a current read link. */ }
  }
  return rows.map(row => urls.has(row.id.toLowerCase()) ? { ...row, url: urls.get(row.id.toLowerCase()) ?? null } : { ...row });
}
