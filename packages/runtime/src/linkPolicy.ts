/**
 * Link policy for Vega's X posts. X throttles reach on posts that carry
 * external links, so TOP-LEVEL posts are kept link-free. Replies and DMs may
 * keep links — the caller decides whether to apply this. On-platform links
 * (x.com / twitter.com / t.co) are exempt: they don't hurt reach.
 *
 * This is a pragmatic detector, not a full URL parser. It catches explicit
 * URLs, www-prefixed and bare domains (known TLDs only), and single-token
 * bracket obfuscation (example[.]com, example(dot)com). It deliberately ignores
 * dotted non-domains (Next.js, 3.14, "U.S.") so it never mangles real prose.
 */

const EXEMPT_DOMAINS = ["x.com", "twitter.com", "t.co"];

// Curated TLDs that make a bare, scheme-less token read as a real domain. Kept
// a closed set (not "any 2+ letters") so "Next.js" / "node.js" / "3.14" don't
// trip the detector.
const BARE_TLDS = new Set([
  "com", "net", "org", "io", "dev", "co", "ai", "app", "xyz", "me", "gg",
  "so", "sh", "to", "ly", "info", "biz", "tech", "site", "online", "store",
  "blog", "page", "link", "club", "live", "news", "tv", "fm", "cc", "pro",
  "design", "studio", "wtf", "lol", "social",
]);

/** Collapse single-token dot obfuscation: example[.]com / example(dot)com → example.com */
function deobfuscate(token: string): string {
  return token.replace(/[[({]\s*(?:dot|\.)\s*[)\]}]/gi, ".");
}

/** Strip wrapping/trailing punctuation a domain may be embedded in. */
function trimWrapping(token: string): string {
  return token.replace(/^[("'<[]+/, "").replace(/[)"'>\].,;:!?]+$/, "");
}

/** If the cleaned token reads as a link, return its bare hostname; else null. */
function linkHost(rawToken: string): string | null {
  const token = trimWrapping(deobfuscate(rawToken));
  if (!token) return null;

  let host: string | null = null;
  const schemed = /^https?:\/\/(.+)$/i.exec(token);
  const wwwed = /^www\.(.+)$/i.exec(token);
  if (schemed?.[1]) {
    host = schemed[1];
  } else if (wwwed?.[1]) {
    host = wwwed[1];
  } else {
    const m = /^([a-z0-9-]+(?:\.[a-z0-9-]+)*\.([a-z]{2,24}))(?:\/[^\s]*)?$/i.exec(token);
    const tld = m?.[2];
    if (!m || !tld || !BARE_TLDS.has(tld.toLowerCase())) return null;
    host = m[1] ?? null;
  }
  if (!host) return null;

  // Reduce to the hostname (drop any path/port/query that rode along) + lowercase.
  const bare = host.split(/[/:?#]/)[0];
  return bare ? bare.toLowerCase().replace(/^www\./, "") : null;
}

function isExempt(host: string): boolean {
  return EXEMPT_DOMAINS.some((d) => host === d || host.endsWith("." + d));
}

/** True if `text` contains at least one EXTERNAL (non-exempt) link/domain. */
export function containsExternalLink(text: string): boolean {
  for (const token of text.split(/\s+/)) {
    const host = linkHost(token);
    if (host && !isExempt(host)) return true;
  }
  return false;
}

/**
 * Remove external links from a top-level post, collapsing the whitespace they
 * leave behind. Self-links + plain text are untouched. Idempotent.
 */
export function stripExternalLinksForPost(text: string): string {
  const parts = text.split(/(\s+)/); // keep separators so spacing can be rebuilt
  const kept = parts.map((part) => {
    if (part === "" || /^\s+$/.test(part)) return part;
    const host = linkHost(part);
    return host && !isExempt(host) ? "" : part;
  });
  return kept
    .join("")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/ +\n/g, "\n")
    .replace(/\n +/g, "\n")
    .replace(/[ \t]+$/gm, "")
    .trim();
}
