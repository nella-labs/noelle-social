// The copyable "path" for a piece of content media — the resolvable link a user
// can paste anywhere (browser, doc, another tool). Uploaded media stores a
// relative url (`/media/<key>`) and external content-pipeline files store
// `/external-media/<rel>`; both become a complete absolute URL by prefixing the
// current origin. Already-absolute urls (prod GCS signed links) pass through.
//
// Computed client-side at click time so it stays SSR-safe (no window at render).
export function mediaCopyPath(url: string | null | undefined): string {
  if (!url) return "";
  if (/^[a-z]+:\/\//i.test(url)) return url;
  const origin = typeof window !== "undefined" ? window.location.origin : "";
  return `${origin}${url}`;
}
