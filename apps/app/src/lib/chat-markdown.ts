/**
 * Minimal, XSS-safe parse of agent chat text into render segments.
 *
 * Recognises two link forms and leaves everything else as plain text:
 *   - Markdown links:  [label](https://…)
 *   - Bare URLs:       https://…
 *
 * Both are restricted to the http/https scheme by the regex itself, so a
 * `javascript:` URL never becomes a link — it falls through to plain text.
 * The renderer maps segments to React <a>/text nodes (no HTML string, no
 * dangerouslySetInnerHTML), so there is no injection surface.
 */
export type MessageSegment =
  | { type: "text"; value: string }
  | { type: "link"; label: string; href: string };

// Group 1/2 = markdown [label](url); group 3 = bare url. Only http(s).
const LINK_RE = /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)|(https?:\/\/[^\s)]+)/gi;

export function parseMessageSegments(text: string): MessageSegment[] {
  const segments: MessageSegment[] = [];
  let last = 0;
  // Fresh regex state per call (LINK_RE is module-level + global).
  LINK_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = LINK_RE.exec(text)) !== null) {
    if (m.index > last) {
      segments.push({ type: "text", value: text.slice(last, m.index) });
    }
    if (m[1] && m[2]) {
      segments.push({ type: "link", label: m[1], href: m[2] });
    } else if (m[3]) {
      segments.push({ type: "link", label: m[3], href: m[3] });
    }
    last = LINK_RE.lastIndex;
  }
  if (last < text.length) {
    segments.push({ type: "text", value: text.slice(last) });
  }
  return segments;
}
