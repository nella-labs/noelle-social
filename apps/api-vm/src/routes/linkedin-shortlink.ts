import { resolveLinkedInIdentity, type CanonicalIdentity } from "./linkedin-identity.js";

const SHORT_LINK = /^https:\/\/lnkd\.in\/p\/[A-Za-z0-9_-]{1,128}$/;
const ACTIVITY_META_URL = /^https:\/\/www\.linkedin\.com\/feed\/update\/urn:li:activity:\d{10,}\/?$/;
const MAX_HTML_BYTES = 256_000;

export const isLinkedInShortUrl = (value: string): boolean => SHORT_LINK.test(value);

function linkedInPostUrl(location: string | null): string {
  if (!location) throw new Error("LinkedIn short link omitted redirect");
  let url: URL;
  try { url = new URL(location); } catch { throw new Error("LinkedIn short link returned invalid redirect"); }
  if (url.protocol !== "https:" || url.hostname !== "www.linkedin.com" ||
      url.port || url.username || url.password || !/^\/posts\/[A-Za-z0-9_%.-]+\/?$/.test(url.pathname)) {
    throw new Error("LinkedIn short link returned unsafe redirect");
  }
  return `${url.origin}${url.pathname}`;
}

async function boundedHtml(response: Response): Promise<string> {
  if (!response.ok || !response.headers.get("content-type")?.toLowerCase().includes("text/html")) {
    throw new Error("LinkedIn public post unavailable");
  }
  if (Number(response.headers.get("content-length") ?? 0) > MAX_HTML_BYTES) {
    throw new Error("LinkedIn public post exceeded size limit");
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error("LinkedIn public post returned no body");
  const decoder = new TextDecoder();
  let bytes = 0;
  let html = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_HTML_BYTES) throw new Error("LinkedIn public post exceeded size limit");
      html += decoder.decode(value, { stream: true });
    }
    return html + decoder.decode();
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

function activityUrlFrom(html: string): string {
  for (const [tag] of html.matchAll(/<meta\b[^>]*>/gi)) {
    const property = tag.match(/\bproperty\s*=\s*(["'])(.*?)\1/i)?.[2];
    if (property?.toLowerCase() !== "lnkd:url") continue;
    const url = tag.match(/\bcontent\s*=\s*(["'])(.*?)\1/i)?.[2];
    if (!url || !ACTIVITY_META_URL.test(url)) break;
    return url;
  }
  throw new Error("LinkedIn public post omitted activity URL");
}

/** Resolve only a validated copied short link. The redirect's ugcPost number
 * can differ from the activity ID, so identity comes from public metadata. */
export async function resolveLinkedInShortUrl(shortUrl: string): Promise<CanonicalIdentity | null> {
  if (!isLinkedInShortUrl(shortUrl)) return null;
  const signal = AbortSignal.timeout(5_000);
  const head = await fetch(shortUrl, { method: "HEAD", redirect: "manual", signal });
  if (![301, 302, 303, 307, 308].includes(head.status)) throw new Error("LinkedIn short link unavailable");
  const postUrl = linkedInPostUrl(head.headers.get("location"));
  const html = await boundedHtml(await fetch(postUrl, {
    method: "GET", redirect: "error", signal, headers: { accept: "text/html" },
  }));
  const identity = await resolveLinkedInIdentity({ url: activityUrlFrom(html) });
  if (!identity) throw new Error("LinkedIn public post returned invalid activity URL");
  return identity;
}
