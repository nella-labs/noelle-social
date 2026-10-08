import { normalizeObservation } from "./linkedin-discovery.js";

export type CanonicalIdentity = { externalId: string; urn: string; url: string };

const SHARE_URN = /^urn:li:share:(\d{10,})$/;
const MAX_EMBED_BYTES = 256_000;

/** Only Jev-qualified candidates reach this resolver. The URL is constructed
 * from a validated share ID, never supplied by the browser. */
export async function resolveLinkedInIdentity(input: { urn?: string; url?: string }): Promise<CanonicalIdentity | null> {
  const shareId = SHARE_URN.exec(input.urn ?? "")?.[1];
  if (shareId) {
    if (input.url) return null;
    const response = await fetch(`https://www.linkedin.com/embed/feed/update/urn:li:share:${shareId}?collapsed=1`, {
      redirect: "error",
      signal: AbortSignal.timeout(5_000),
      headers: { accept: "text/html" },
    });
    if (!response.ok || !response.headers.get("content-type")?.toLowerCase().includes("text/html")) {
      throw new Error("LinkedIn embed unavailable");
    }
    const reader = response.body?.getReader();
    if (!reader) throw new Error("LinkedIn embed returned no body");
    let bytes = 0;
    let html = "";
    const decoder = new TextDecoder();
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > MAX_EMBED_BYTES) throw new Error("LinkedIn embed exceeded size limit");
        html += decoder.decode(value, { stream: true });
      }
      html += decoder.decode();
    } finally {
      reader.releaseLock();
    }
    const canonicalTag = [...html.matchAll(/<link\b[^>]*>/gi)]
      .map(([tag]) => tag)
      .find((tag) => /\brel\s*=\s*(["'])canonical\1/i.test(tag));
    const href = canonicalTag?.match(/\bhref\s*=\s*(["'])(.*?)\1/i)?.[2];
    if (!href) throw new Error("LinkedIn embed omitted canonical post URL");
    const post = normalizeObservation({ text: "identity", url: href });
    if (!post) throw new Error("LinkedIn embed returned invalid canonical post URL");
    return { externalId: post.externalId, urn: post.urn, url: `https://www.linkedin.com/feed/update/${post.urn}/` };
  }

  const post = normalizeObservation({ text: "identity", ...input });
  if (!post || (input.url && !/activity[-:](\d{10,})/i.test(input.url))) return null;
  return { externalId: post.externalId, urn: post.urn, url: `https://www.linkedin.com/feed/update/${post.urn}/` };
}
