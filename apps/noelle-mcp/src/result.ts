import type { ToolResult } from "./types.js";

// Strip lone UTF-16 surrogates (a high surrogate not followed by a low, or a
// low not preceded by a high). Such code units cannot be encoded to valid
// UTF-8/JSON: a single one anywhere in a tool result makes the downstream
// Anthropic API reject the ENTIRE request body ("The request body is not valid
// JSON"), so the whole call appears to fail. The usual source is truncating
// free text that contains astral-plane characters — emoji, or the
// "𝗯𝗼𝗹𝗱"/"𝕚𝕥𝕒𝕝𝕚𝕔" math-alphanumeric letters people use on LinkedIn/X —
// which splits a surrogate pair. `truncate` below avoids creating them; this is
// the belt-and-suspenders guard applied at every result boundary so no tool can
// emit an unencodable payload regardless of how its text was assembled.
export function sanitizeText(s: string): string {
  return s.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "");
}

// A plain text/markdown result.
export function text(body: string): ToolResult {
  return { content: [{ type: "text", text: sanitizeText(body) }] };
}

// An error result. isError: true tells the MCP client the call failed.
export function errorResult(message: string): ToolResult {
  return { isError: true, content: [{ type: "text", text: sanitizeText(`Error: ${message}`) }] };
}

// Wrap a handler body so any thrown error becomes a clean isError result
// instead of bubbling as an uncaught rejection. Used by every tool module.
export async function guard(fn: () => Promise<ToolResult>): Promise<ToolResult> {
  try {
    return await fn();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return errorResult(msg);
  }
}

// Truncate long free-text (post bodies, lead text) for list views. Slices by
// Unicode code POINTS (via the string iterator), never by UTF-16 code units, so
// it can never cut an astral-plane character's surrogate pair in half and leave
// a lone surrogate that would poison the JSON payload (see sanitizeText above).
export function truncate(s: string | null | undefined, n = 120): string {
  if (!s) return "";
  const flat = s.replace(/\s+/g, " ").trim();
  const chars = Array.from(flat);
  return chars.length > n ? chars.slice(0, n - 1).join("") + "…" : flat;
}

// Render a compact GitHub-flavored markdown table. Cells are stringified and
// pipe-escaped. Returns "_none_" for an empty row set.
export function mdTable(headers: string[], rows: Array<Array<unknown>>): string {
  if (rows.length === 0) return "_none_";
  const esc = (v: unknown) =>
    (v === null || v === undefined ? "" : String(v)).replace(/\|/g, "\\|").replace(/\n/g, " ");
  const head = `| ${headers.join(" | ")} |`;
  const sep = `| ${headers.map(() => "---").join(" | ")} |`;
  const body = rows.map((r) => `| ${r.map(esc).join(" | ")} |`).join("\n");
  return `${head}\n${sep}\n${body}`;
}

// Render an object as a markdown "key: value" definition list, skipping
// null/undefined. Good for single-record "get" tools.
export function mdFields(obj: Record<string, unknown>): string {
  const lines: string[] = [];
  for (const [k, v] of Object.entries(obj)) {
    if (v === null || v === undefined || v === "") continue;
    const val =
      typeof v === "object" ? "```json\n" + JSON.stringify(v, null, 2) + "\n```" : String(v);
    lines.push(`- **${k}:** ${val}`);
  }
  return lines.length ? lines.join("\n") : "_no fields_";
}

// ISO timestamp → short "3h ago" style, best-effort. Falls back to the raw value.
export function ago(ts: unknown): string {
  if (!ts) return "";
  const d = ts instanceof Date ? ts : new Date(String(ts));
  const ms = d.getTime();
  if (Number.isNaN(ms)) return String(ts);
  const diff = Date.now() - ms;
  const abs = Math.abs(diff);
  const suffix = diff >= 0 ? "ago" : "from now";
  const mins = Math.round(abs / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ${suffix}`;
  const hrs = Math.round(mins / 60);
  if (hrs < 48) return `${hrs}h ${suffix}`;
  const days = Math.round(hrs / 24);
  return `${days}d ${suffix}`;
}
