/**
 * Plain-text + Markdown export for a Nova video draft's script.
 *
 * Pure string builders (easy to unit-test) plus a tiny browser download helper.
 * The studio editor passes its LIVE state (the edited full script + per-beat
 * voice lines), so the export always reflects what's on screen, not just what
 * was last saved.
 */

export interface ScriptExportBeat {
  /** Beat start, seconds. */
  tStart: number;
  /** Beat end, seconds. */
  tEnd: number;
  /** What the beat is for (hook / claim / payoff …). */
  purpose: string;
  /** The voice line read over this beat (edited). */
  line: string;
  /** Footage cues mentioned in this beat's line. */
  cues: string[];
  /** Short labels for the on-screen visuals during this beat. */
  visuals: string[];
}

export interface ScriptExportInput {
  /** The idea/hook the draft is built on. */
  hook: string;
  /** draft / ready / published. */
  status: string;
  /** Suggested soundtrack names, if any. */
  sounds: string[];
  /** The storyboard beats (may be empty for older drafts). */
  beats: ScriptExportBeat[];
  /** The full script as currently edited. */
  script: string;
}

/** Format a beat's `tStart–tEnd` like the studio chrome ("0–5s"). */
function beatRange(b: ScriptExportBeat): string {
  return `${b.tStart}–${b.tEnd}s`;
}

/**
 * A clean, paste-ready plain-text script — the words the founder reads to
 * record. Prefers the full script; falls back to the beat lines so the export
 * is never empty.
 */
export function buildPlainTextScript(input: ScriptExportInput): string {
  const out: string[] = [];
  if (input.hook.trim()) out.push(input.hook.trim());

  const script = input.script.trim();
  if (script) {
    out.push("", script);
  } else if (input.beats.length) {
    out.push("");
    for (const b of input.beats) {
      const line = b.line.trim();
      if (line) out.push(`[${beatRange(b)}] ${line}`);
    }
  }
  return `${out.join("\n")}\n`;
}

/**
 * A structured Markdown export — title, soundtrack, the full storyboard (timed
 * beats with voice lines, footage cues, on-screen visuals), and the full
 * script. Built for pasting into a doc / Obsidian.
 */
export function buildMarkdownScript(input: ScriptExportInput): string {
  const out: string[] = [];
  out.push(`# ${input.hook.trim() || "Untitled video"}`);

  const meta: string[] = [`**Status:** ${input.status}`];
  if (input.sounds.length) meta.push(`**Soundtrack:** ${input.sounds.join(", ")}`);
  out.push("", meta.join(" · "));

  if (input.beats.length) {
    out.push("", "## Storyboard");
    for (const b of input.beats) {
      const purpose = b.purpose.trim() ? ` · ${b.purpose.trim()}` : "";
      out.push("", `### ${beatRange(b)}${purpose}`);
      if (b.line.trim()) out.push("", b.line.trim());
      if (b.cues.length) out.push("", `🎬 _Footage:_ ${b.cues.join("; ")}`);
      if (b.visuals.length) out.push("", `🖼 _On screen:_ ${b.visuals.join("; ")}`);
    }
  }

  if (input.script.trim()) {
    out.push("", "## Full script", "", input.script.trim());
  }

  return `${out.join("\n")}\n`;
}

/** Filesystem-safe slug from the hook for the download filename. */
export function scriptFilenameSlug(hook: string): string {
  const slug = hook
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50);
  return slug || "video-script";
}

/** Trigger a client-side download of `content` as a file. No-op on the server. */
export function downloadTextFile(filename: string, content: string, mime: string): void {
  if (typeof document === "undefined") return;
  const blob = new Blob([content], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
